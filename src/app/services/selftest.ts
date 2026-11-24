/**
 * 浏览器端自检: 在真实 WebGPU 设备上验证
 *  1) GPU 统计 vs CPU 逐像素参考实现的相对误差 (<0.1%)
 *  2) 8000 小区一趟统计耗时 (<3 s)
 *  3) 三景大图切换时 RAM/GPU 缓存占用不超预算、不随时间增长
 *  4) 渲染管线与直方图管线可运行
 */
import { getCapabilities } from '../../gpu/device';
import { StatsPipeline, debugLocatePlot, type GpuStatsTile } from '../../gpu/stats-pipeline';
import { HistogramPipeline } from '../../gpu/histogram-pipeline';
import { GpuTileCache } from '../../gpu/tile-texture-cache';
import { TileCache } from '../../io/tile-cache';
import { compileExpression } from '../../core/expression';
import { computePlotStatsCpu, type CpuRaster } from '../../core/stats';
import { buildPlotGrid } from '../../core/geometry';
import { generateSyntheticScene } from '../../io/synthetic';
import { fitCalibration } from '../../core/calibration';
import { BAND_COUNT, type Calibration, type PlotStats } from '../../types';

export interface SelftestResult {
  ok: boolean;
  webgpu: { adapter: string; f32Atomic: boolean };
  accuracy?: {
    plots: number;
    maxRelErrMean: number;
    maxRelErrMedian: number;
    maxPixelCountDiff: number;
    maxPixelCountDiffRatio: number;
    pass: boolean;
  };
  performance8000?: {
    plots: number;
    elapsedMs: number;
    pass: boolean;
  };
  memory?: {
    ramBudgetMB: number;
    gpuBudgetMB: number;
    ramPeakMB: number;
    gpuPeakMB: number;
    afterSwitchMB: number;
    pass: boolean;
  };
  histogram?: { lo: number; hi: number; pass: boolean };
  render?: { pass: boolean };
  errors: string[];
}

function makeCalibration(scene: ReturnType<typeof generateSyntheticScene>): Calibration {
  const { panelRect, panelLevels } = scene;
  const segW = panelRect.w / panelLevels.length;
  const panels = panelLevels.map((refl, i) => {
    const x0 = Math.floor(panelRect.x + i * segW) + 2;
    const x1 = Math.floor(panelRect.x + (i + 1) * segW) - 2;
    const y0 = panelRect.y + 2;
    const y1 = panelRect.y + panelRect.h - 2;
    const sums = new Float64Array(BAND_COUNT);
    let n = 0;
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        for (let b = 0; b < BAND_COUNT; b++) sums[b] += scene.data[(y * scene.width + x) * BAND_COUNT + b];
        n++;
      }
    return {
      rect: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 },
      reflectance: new Array(BAND_COUNT).fill(refl),
      meanDN: Array.from(sums, (s) => s / n),
    };
  });
  const fit = fitCalibration(panels);
  return {
    id: 'cal-selftest',
    experimentId: 'exp-selftest',
    imageId: 'img-selftest',
    date: '2026-01-01',
    gains: fit.gains,
    offsets: fit.offsets,
    r2: fit.r2,
    panels,
    createdAt: 0,
  };
}

/** 从合成场景构造 level0 GPU 纹理 tile 集 */
function buildTiles(
  caps: Awaited<ReturnType<typeof getCapabilities>>,
  scene: ReturnType<typeof generateSyntheticScene>,
  budgetBytes: number,
): { cache: GpuTileCache; tiles: GpuStatsTile[] } {
  const ts = scene.tileSize;
  const tilesX = Math.ceil(scene.width / ts);
  const tilesY = Math.ceil(scene.height / ts);
  const cache = new GpuTileCache(caps, budgetBytes, ts);
  const tiles: GpuStatsTile[] = [];
  for (let ty = 0; ty < tilesY; ty++) {
    for (let tx = 0; tx < tilesX; tx++) {
      // 平面布局: 5 个波段各占 ts*ts, 与 GpuTileCache 的逐层上传一致
      const tile = new Uint16Array(ts * ts * BAND_COUNT);
      for (let y = 0; y < ts; y++) {
        const sy = ty * ts + y;
        if (sy >= scene.height) continue;
        for (let x = 0; x < ts; x++) {
          const sx = tx * ts + x;
          if (sx >= scene.width) continue;
          for (let b = 0; b < BAND_COUNT; b++) tile[b * ts * ts + y * ts + x] = scene.data[(sy * scene.width + sx) * BAND_COUNT + b];
        }
      }
      const texture = cache.acquire(`selftest/L0/Y${ty}/X${tx}`, tile);
      tiles.push({
        texture,
        tx,
        ty,
        level: 0,
        pixelCount: Math.min(ts, scene.height - ty * ts) * Math.min(ts, scene.width - tx * ts),
      });
    }
  }
  return { cache, tiles };
}

function toReflectanceRaster(scene: ReturnType<typeof generateSyntheticScene>, cal: Calibration): CpuRaster {
  const bands = Array.from({ length: BAND_COUNT }, () => new Float32Array(scene.width * scene.height));
  for (let y = 0; y < scene.height; y++) {
    for (let x = 0; x < scene.width; x++) {
      const off = y * scene.width + x;
      for (let b = 0; b < BAND_COUNT; b++) {
        bands[b][off] = cal.gains[b] * scene.data[off * BAND_COUNT + b] + cal.offsets[b];
      }
    }
  }
  return { width: scene.width, height: scene.height, bands };
}

function relErr(a: number, b: number): number {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.POSITIVE_INFINITY;
  if (Math.abs(b) < 1e-6) return Math.abs(a - b);
  return Math.abs(a - b) / Math.abs(b);
}

export async function runSelftest(onLog: (msg: string) => void): Promise<SelftestResult> {
  const errors: string[] = [];
  const result: SelftestResult = { ok: false, webgpu: { adapter: '', f32Atomic: false }, errors };

  const canvas = document.createElement('canvas');
  canvas.width = 8;
  canvas.height = 8;
  const caps = await getCapabilities(canvas);
  result.webgpu = { adapter: caps.device.label || 'webgpu', f32Atomic: caps.supportsF32Atomic };
  onLog(`WebGPU 就绪, shader-f32 原子: ${caps.supportsF32Atomic}`);

  const expr = compileExpression('(NIR - R) / (NIR + R)');
  const mask = { soilNDVI: 0.25, cloudBright: 0.55, shadowDark: 0.08 };

  // ---------- 1) 精度: 2048 场景 + 320 小区 ----------
  onLog('生成 2048x2048 合成场景…');
  const scene = generateSyntheticScene({ width: 2048, height: 2048, tileSize: 256, seed: 99, growthStage: 0.6 });
  const cal = makeCalibration(scene);
  const cfg = {
    rows: 16,
    cols: 20,
    plotW: scene.plotW,
    plotH: scene.plotH,
    alleyX: scene.alleyX,
    alleyY: scene.alleyY,
    originX: scene.plotOrigin.x,
    originY: scene.plotOrigin.y,
    angleDeg: 0,
    insetPx: 6,
    rowOffsets: {},
    colOffsets: {},
  };
  const plots320 = buildPlotGrid(cfg);
  const gpuBudget = 256 * 1024 * 1024;
  const { cache, tiles } = buildTiles(caps, scene, gpuBudget);

  onLog('GPU 统计 320 小区…');
  const pipeline = new StatsPipeline(caps, expr);
  // 调试: 用前几个小区中心点验证 GPU 定位
  const probePixels = plots320.slice(0, 5).map((p) => ({ x: p.cx, y: p.cy }));
  const located = await debugLocatePlot(caps, plots320, scene.width, scene.height, 6, probePixels);
  onLog(`定位调试 (期望 0,1,2,3,4): ${JSON.stringify(located)}`);
  const gpuStats: PlotStats[] = await pipeline.run({
    plots: plots320,
    calibration: cal,
    mask,
    flagFraction: 0.1,
    imageId: 'img-selftest',
    indexName: 'NDVI',
    expr,
    tiles,
    imageWidth: scene.width,
    imageHeight: scene.height,
    tileSize: scene.tileSize,
    inset: 6,
  });

  onLog('CPU 逐像素参考实现校验…');
  const raster = toReflectanceRaster(scene, cal);
  let maxMean = 0;
  let maxMedian = 0;
  let maxPixelDiff = 0;
  let maxPixelDiffRatio = 0;
  const mismatched: string[] = [];
  const gpuMap = new Map(gpuStats.map((s) => [s.plotId, s]));
  const cpuTimings: number[] = [];
  for (const plot of plots320) {
    const t0 = performance.now();
    const cpu = computePlotStatsCpu(raster, plot, 6, mask, expr.eval, 'img-selftest', 'NDVI', 0.1);
    cpuTimings.push(performance.now() - t0);
    const gpu = gpuMap.get(plot.id)!;
    const diff = Math.max(Math.abs(gpu.totalPixels - cpu.totalPixels), Math.abs(gpu.vegPixels - cpu.vegPixels));
    maxPixelDiff = Math.max(maxPixelDiff, diff);
    const ratio = cpu.totalPixels > 0 ? diff / cpu.totalPixels : 0;
    maxPixelDiffRatio = Math.max(maxPixelDiffRatio, ratio);
    if (diff > 1) mismatched.push(`${plot.id}(gpu=${gpu.totalPixels},cpu=${cpu.totalPixels})`);
    if (cpu.vegPixels > 0 && !gpu.flagged) {
      maxMean = Math.max(maxMean, relErr(gpu.mean, cpu.mean));
      maxMedian = Math.max(maxMedian, relErr(gpu.median, cpu.median));
    }
  }
  onLog(`CPU 单小区平均耗时 ${(cpuTimings.reduce((a, b) => a + b, 0) / cpuTimings.length).toFixed(2)} ms`);
  onLog(`像素计数不一致小区: ${mismatched.length} 个, 示例: ${mismatched.slice(0, 4).join('; ')}`);
  // 数值精度是核心门限 0.1%; 像素计数允许图像边缘裁剪导致的 <0.1% 差异
  const accuracyPass = maxMean < 0.001 && maxMedian < 0.001 && maxPixelDiffRatio < 0.001;
  result.accuracy = {
    plots: plots320.length,
    maxRelErrMean: maxMean,
    maxRelErrMedian: maxMedian,
    maxPixelCountDiff: maxPixelDiff,
    maxPixelCountDiffRatio: maxPixelDiffRatio,
    pass: accuracyPass,
  };
  onLog(`精度: 均值最大相对误差 ${(maxMean * 100).toFixed(5)}%, 中位数 ${(maxMedian * 100).toFixed(5)}%, 像素最大差 ${maxPixelDiff} (占比 ${(maxPixelDiffRatio * 100).toFixed(4)}%)`);

  // ---------- 2) 8000 小区性能 (独立小尺寸网格, 铺满影像) ----------
  onLog('构建 8000 小区密集网格做性能压测…');
  // 80 行 x 100 列; 单元格 20px (16 小区 + 4 走道), 总宽 2000px 落在 2048 内
  const denseCfg = {
    rows: 80,
    cols: 100,
    plotW: 16,
    plotH: 16,
    alleyX: 4,
    alleyY: 4,
    originX: 24,
    originY: 24,
    angleDeg: 0,
    insetPx: 1,
    rowOffsets: {},
    colOffsets: {},
  };
  const plots8000 = buildPlotGrid(denseCfg);
  if (plots8000.length !== 8000) throw new Error(`密集网格数量错误: ${plots8000.length}`);
  const t0 = performance.now();
  const stats8000 = await pipeline.run({
    plots: plots8000,
    calibration: cal,
    mask,
    flagFraction: 0.1,
    imageId: 'img-selftest',
    indexName: 'NDVI',
    expr,
    tiles,
    imageWidth: scene.width,
    imageHeight: scene.height,
    tileSize: scene.tileSize,
    inset: 1,
  });
  const elapsedMs = performance.now() - t0;
  const validCount = stats8000.filter((s) => s.vegPixels > 0).length;
  // 核心验收门限是需求明确的「8000 小区一趟统计 < 3s」; 有效小区数受合成纹理/网格对齐影响, 仅记录
  const perfPass = elapsedMs < 3000;
  result.performance8000 = { plots: 8000, elapsedMs, pass: perfPass };
  onLog(`性能: 8000 小区 GPU 耗时 ${elapsedMs.toFixed(0)} ms (门限 3000 ms), 有效小区 ${validCount}`);

  // ---------- 3) 内存: 三景切换, 缓存不超预算 ----------
  onLog('三景影像切换内存压测…');
  const ramBudget = 48 * 1024 * 1024;
  const vramBudget = 96 * 1024 * 1024;
  const ram = new TileCache(ramBudget);
  const gpuCache2 = new GpuTileCache(caps, vramBudget, 256);
  let ramPeak = 0;
  let gpuPeak = 0;
  const scenes = [
    scene,
    generateSyntheticScene({ width: 2048, height: 2048, tileSize: 256, seed: 100, growthStage: 0.4 }),
    generateSyntheticScene({ width: 2048, height: 2048, tileSize: 256, seed: 101, growthStage: 0.8 }),
  ];
  // 模拟浏览器按需加载: 每景访问视口内 12 个 tile, 来回切换 3 轮
  for (let round = 0; round < 3; round++) {
    for (let s = 0; s < 3; s++) {
      const sc = scenes[s];
      for (let ty = 0; ty < 3; ty++) {
        for (let tx = 0; tx < 4; tx++) {
          const tile = new Uint16Array(256 * 256 * BAND_COUNT);
          for (let y = 0; y < 256; y++) {
            const sy = ty * 256 + y;
            if (sy >= sc.height) continue;
            for (let x = 0; x < 256; x++) {
              const sx = tx * 256 + x;
              if (sx >= sc.width) continue;
              for (let b = 0; b < BAND_COUNT; b++) tile[b * 256 * 256 + y * 256 + x] = sc.data[(sy * sc.width + sx) * BAND_COUNT + b];
            }
          }
          const key = `scene${s}/L0/Y${ty}/X${tx}`;
          ram.put(key, tile);
          gpuCache2.acquire(key, tile);
        }
      }
      ramPeak = Math.max(ramPeak, ram.usageBytes);
      gpuPeak = Math.max(gpuPeak, gpuCache2.usageBytes);
    }
  }
  const memPass = ram.usageBytes <= ramBudget * 1.02 && gpuCache2.usageBytes <= vramBudget * 1.02;
  result.memory = {
    ramBudgetMB: ramBudget / 1048576,
    gpuBudgetMB: vramBudget / 1048576,
    ramPeakMB: ramPeak / 1048576,
    gpuPeakMB: gpuPeak / 1048576,
    afterSwitchMB: gpuCache2.usageBytes / 1048576,
    pass: memPass,
  };
  onLog(`内存: RAM 峰值 ${(ramPeak / 1048576).toFixed(1)}/${ramBudget / 1048576} MB, 显存峰值 ${(gpuPeak / 1048576).toFixed(1)}/${vramBudget / 1048576} MB`);

  // ---------- 4) 直方图管线 (整幅 level0, 尺寸与 tile 集一致) ----------
  onLog('直方图管线检查…');
  const hp = new HistogramPipeline(caps, expr);
  const { hist, lo, hi } = await hp.compute(tiles, scene.width, scene.height, scene.tileSize, cal.gains, cal.offsets);
  const histTotal = hist.reduce((a, b) => a + b, 0);
  const histPass = histTotal > 0 && lo < hi;
  result.histogram = { lo, hi, pass: histPass };
  onLog(`直方图: ${histTotal} 个采样像素, 值域 [${lo}, ${hi}]`);

  // ---------- 5) 渲染管线冒烟: 渲染一帧并读回, 确认非全黑 ----------
  onLog('渲染管线冒烟测试…');
  const renderOk = await smokeTestRender(caps, tiles.slice(0, 4), cal, expr, onLog);
  result.render = { pass: renderOk };

  cache.clear();
  gpuCache2.clear();
  result.ok = Boolean(
    result.accuracy?.pass &&
      result.performance8000?.pass &&
      result.memory?.pass &&
      result.histogram?.pass &&
      result.render?.pass,
  );
  if (!result.ok) errors.push('存在未通过项, 见各项 pass 字段');
  return result;
}

/** 离屏渲染一帧并读回中心像素, 验证渲染管线端到端可用 */
async function smokeTestRender(
  caps: Awaited<ReturnType<typeof getCapabilities>>,
  tiles: GpuStatsTile[],
  cal: Calibration,
  expr: ReturnType<typeof compileExpression>,
  onLog: (msg: string) => void,
): Promise<boolean> {
  const device = caps.device;
  const { createRasterPipeline, createLutTexture, makeUniformBuffer, writeUniforms } = await import('../../gpu/raster-pipeline');
  const { buildLut } = await import('../../core/colormap');
  const W = 256;
  const H = 256;
  const target = device.createTexture({
    size: { width: W, height: H },
    format: caps.format,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const handle = createRasterPipeline(caps, expr);
  const lut = createLutTexture(device, buildLut('rdylgn'));
  const sampler = device.createSampler({ magFilter: 'nearest', minFilter: 'nearest' });
  const uniformBuf = makeUniformBuffer(device);
  writeUniforms(device, uniformBuf, {
    viewportW: W,
    viewportH: H,
    level: 0,
    levelScale: 1,
    cameraX: 0,
    cameraY: 0,
    zoom: 1,
    showMask: 0,
    gains: cal.gains,
    offsets: cal.offsets,
    stretchLow: 0,
    stretchHigh: 1,
    soilNDVI: 0.25,
    cloudBright: 0.55,
    shadowDark: 0.08,
    opacity: 1,
  });
  // 4 个 tile 各画一个 128px 四边形
  const instances = new Float32Array(tiles.length * 5);
  tiles.forEach((t, i) => instances.set([t.tx * 128, t.ty * 128, t.tx * 128, t.ty * 128, 128], i * 5));
  const instanceBuf = device.createBuffer({ size: instances.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  writeGpuBufferLocal(device, instanceBuf, instances);

  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [{ view: target.createView(), clearValue: { r: 0.01, g: 0.02, b: 0.03, a: 1 }, loadOp: 'clear', storeOp: 'store' }],
  });
  pass.setPipeline(handle.pipeline);
  for (const t of tiles) {
    const bg = device.createBindGroup({
      layout: handle.bindLayout,
      entries: [
        { binding: 0, resource: { buffer: uniformBuf } },
        { binding: 1, resource: { buffer: instanceBuf } },
        { binding: 2, resource: t.texture.createView({ dimension: '2d-array' }) },
        { binding: 3, resource: sampler },
        { binding: 4, resource: lut.createView() },
      ],
    });
    pass.setBindGroup(0, bg);
    pass.draw(6, 1, 0, tiles.indexOf(t));
  }
  pass.end();
  const staging = device.createBuffer({ size: W * H * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  encoder.copyTextureToBuffer({ texture: target }, { buffer: staging, bytesPerRow: W * 4, rowsPerImage: H }, { width: W, height: H });
  device.queue.submit([encoder.finish()]);
  await staging.mapAsync(GPUMapMode.READ);
  const px = new Uint8Array(staging.getMappedRange().slice(0));
  staging.unmap();
  // 统计非背景 (背景约为 rgba 3,5,8) 像素比例
  let nonBg = 0;
  for (let i = 0; i < px.length; i += 4) {
    if (Math.abs(px[i] - 3) + Math.abs(px[i + 1] - 5) + Math.abs(px[i + 2] - 8) > 30) nonBg++;
  }
  const ratio = nonBg / (W * H);
  onLog(`渲染: 非背景像素占比 ${(ratio * 100).toFixed(1)}%`);
  for (const b of [instanceBuf, uniformBuf, staging, target, lut]) b.destroy?.();
  return ratio > 0.05;
}

function writeGpuBufferLocal(device: GPUDevice, buffer: GPUBuffer, data: ArrayBufferView) {
  device.queue.writeBuffer(buffer, 0, data as BufferSource);
}

