import type { GpuCapabilities } from '../gpu/device';
import { GpuTileCache } from '../gpu/tile-texture-cache';
import { TileCache } from './tile-cache';
import { getTile } from '../db/idb';
import type { Calibration, FlightImage, MaskThresholds, Plot, PlotStats } from '../types';
import { buildPyramidMeta } from './pyramid';
import { StatsPipeline, type GpuStatsTile } from '../gpu/stats-pipeline';
import { HistogramPipeline, type HistTile, stretchRange } from '../gpu/histogram-pipeline';
import type { CompiledExpression } from '../core/expression';

/**
 * 栅格服务: 串接 IDB 持久切片 -> RAM LRU -> 显存 LRU -> GPU 管线。
 * 两级缓存都有字节预算, 影像切换时按 imageId 定向淘汰, 内存/显存占用有硬上限。
 */
export class RasterService {
  readonly ram: TileCache;
  readonly gpu: GpuTileCache;
  readonly meta: ReturnType<typeof buildPyramidMeta>;
  private statsPipelineByExpr = new Map<string, StatsPipeline>();

  constructor(
    public caps: GpuCapabilities,
    public image: FlightImage,
    ramBudgetBytes: number,
    gpuBudgetBytes: number,
  ) {
    this.ram = new TileCache(ramBudgetBytes);
    this.gpu = new GpuTileCache(caps, gpuBudgetBytes, image.tileSize);
    this.meta = buildPyramidMeta(image.width, image.height, image.tileSize);
  }

  private tileCacheKey(level: number, ty: number, tx: number): string {
    return `${this.image.id}/L${level}/Y${ty}/X${tx}`;
  }

  /** 取切片 uint16 (平面 5 波段), 先 RAM 后 IDB */
  async fetchTile(level: number, ty: number, tx: number): Promise<Uint16Array> {
    const key = this.tileCacheKey(level, ty, tx);
    const hit = this.ram.get(key);
    if (hit) return hit;
    const data = await getTile(this.image.id, level, ty, tx);
    if (!data) throw new Error(`切片缺失: ${key}`);
    this.ram.put(key, data);
    return data;
  }

  /** 取 GPU 纹理 (按需上传, 显存预算内 LRU) */
  async acquireTexture(level: number, ty: number, tx: number): Promise<GPUTexture> {
    const key = this.tileCacheKey(level, ty, tx);
    const cached = this.gpu.get(key);
    if (cached) return cached;
    const data = await this.fetchTile(level, ty, tx);
    return this.gpu.acquire(key, data);
  }

  /** 收集统计所需的 level0 纹理 (仅覆盖 plot AABB 并集涉及的 tile) */
  async collectStatsTiles(plots: Plot[]): Promise<{ tiles: GpuStatsTile[]; totalPixels: number }> {
    const ts = this.image.tileSize;
    const tilesX = Math.ceil(this.image.width / ts);
    const tilesY = Math.ceil(this.image.height / ts);
    const needed = new Set<number>();
    for (const p of plots) {
      const x0 = Math.max(0, Math.floor((p.cx - (p.w + p.h) * 0.71) / ts));
      const y0 = Math.max(0, Math.floor((p.cy - (p.w + p.h) * 0.71) / ts));
      const x1 = Math.min(tilesX - 1, Math.floor((p.cx + (p.w + p.h) * 0.71) / ts));
      const y1 = Math.min(tilesY - 1, Math.floor((p.cy + (p.w + p.h) * 0.71) / ts));
      for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) needed.add(ty * tilesX + tx);
    }
    const tiles: GpuStatsTile[] = [];
    let totalPixels = 0;
    for (const idx of needed) {
      const ty = Math.floor(idx / tilesX);
      const tx = idx % tilesX;
      const texture = await this.acquireTexture(0, ty, tx);
      const x0 = tx * ts;
      const y0 = ty * ts;
      const w = Math.min(ts, this.image.width - x0);
      const h = Math.min(ts, this.image.height - y0);
      const pixelCount = w * h;
      tiles.push({ texture, tx, ty, level: 0, pixelCount });
      totalPixels += pixelCount;
    }
    return { tiles, totalPixels };
  }

  async computeStats(
    plots: Plot[],
    calibration: Calibration,
    mask: MaskThresholds,
    flagFraction: number,
    expr: CompiledExpression,
    inset: number,
    indexName: string,
  ): Promise<PlotStats[]> {
    let pipeline = this.statsPipelineByExpr.get(expr.source);
    if (!pipeline) {
      pipeline = new StatsPipeline(this.caps, expr);
      this.statsPipelineByExpr.set(expr.source, pipeline);
    }
    const { tiles } = await this.collectStatsTiles(plots);
    return pipeline.run({
      plots,
      calibration,
      mask,
      flagFraction,
      imageId: this.image.id,
      indexName,
      expr,
      tiles,
      imageWidth: this.image.width,
      imageHeight: this.image.height,
      tileSize: this.image.tileSize,
      inset,
    });
  }

  /** 在中间金字塔层级算全图直方图用于拉伸 (该级像素量可控) */
  async computeHistogram(expr: CompiledExpression, calibration: Calibration): Promise<{ lo: number; hi: number; hist: Uint32Array }> {
    const targetPixels = 1_500_000;
    let level = 0;
    while (level < this.meta.levels.length - 1) {
      const lvl = this.meta.levels[level];
      if (lvl.width * lvl.height <= targetPixels) break;
      level++;
    }
    const lvl = this.meta.levels[level];
    const tiles: HistTile[] = [];
    for (let ty = 0; ty < lvl.tilesY; ty++) {
      for (let tx = 0; tx < lvl.tilesX; tx++) {
        const texture = await this.acquireTexture(level, ty, tx);
        const w = Math.min(this.image.tileSize, lvl.width - tx * this.image.tileSize);
        const h = Math.min(this.image.tileSize, lvl.height - ty * this.image.tileSize);
        tiles.push({ texture, tx, ty, level, pixelCount: w * h });
      }
    }
    const hp = new HistogramPipeline(this.caps, expr);
    return hp.compute(tiles, lvl.width, lvl.height, this.image.tileSize, calibration.gains, calibration.offsets);
  }

  async getStretch(expr: CompiledExpression, calibration: Calibration, lowPct: number, highPct: number): Promise<[number, number]> {
    const { hist, lo, hi } = await this.computeHistogram(expr, calibration);
    return stretchRange(hist, lo, hi, lowPct, highPct);
  }

  /** 释放该影像占用的全部缓存 (切换/删除时调用) */
  dispose(): void {
    this.ram.evictImage(this.image.id);
    this.gpu.evictImage(this.image.id);
    this.statsPipelineByExpr.clear();
  }
}
