import type { GpuCapabilities } from './device';

/**
 * GPU 切片纹理缓存 (LRU + 字节预算)。
 * 每个切片是 R16Uint 的 5 层纹理数组, 覆盖金字塔某一级的一个 tile。
 * 预算紧张时自动 destroy 旧纹理 —— 三景大图切换不会让显存涨爆。
 */
export interface GpuTile {
  texture: GPUTexture;
  key: string;
  bytes: number;
  lastUsed: number;
}

export class GpuTileCache {
  private map = new Map<string, GpuTile>();
  private usedBytes = 0;
  private clock = 0;

  constructor(
    private caps: GpuCapabilities,
    private budgetBytes: number,
    public tileSize: number,
  ) {}

  setBudget(bytes: number): void {
    this.budgetBytes = bytes;
    this.evict();
  }

  get(key: string): GPUTexture | undefined {
    const t = this.map.get(key);
    if (!t) return undefined;
    t.lastUsed = ++this.clock;
    this.map.delete(key);
    this.map.set(key, t);
    return t.texture;
  }

  /** 上传 (或取回) 切片纹理。data 为平面 uint16: 5 * tileSize^2 */
  acquire(key: string, data: Uint16Array): GPUTexture {
    const hit = this.get(key);
    if (hit) return hit;
    const ts = this.tileSize;
    const texture = this.caps.device.createTexture({
      dimension: '2d',
      size: { width: ts, height: ts, depthOrArrayLayers: 5 },
      format: 'r16uint',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    // 逐层拷贝
    const layerBytes = ts * ts * 2;
    for (let b = 0; b < 5; b++) {
      this.caps.device.queue.writeTexture(
        { texture, mipLevel: 0, origin: { x: 0, y: 0, z: b } },
        data.subarray(b * ts * ts, (b + 1) * ts * ts) as BufferSource,
        { bytesPerRow: ts * 2, rowsPerImage: ts },
        { width: ts, height: ts, depthOrArrayLayers: 1 },
      );
    }
    const bytes = layerBytes * 5;
    this.map.set(key, { texture, key, bytes, lastUsed: ++this.clock });
    this.usedBytes += bytes;
    this.evict();
    return texture;
  }

  evictImage(imageId: string): void {
    const prefix = `${imageId}/`;
    for (const key of [...this.map.keys()]) {
      if (key.startsWith(prefix)) {
        const t = this.map.get(key)!;
        t.texture.destroy();
        this.usedBytes -= t.bytes;
        this.map.delete(key);
      }
    }
  }

  clear(): void {
    for (const t of this.map.values()) t.texture.destroy();
    this.map.clear();
    this.usedBytes = 0;
  }

  get usageBytes(): number {
    return this.usedBytes;
  }

  get size(): number {
    return this.map.size;
  }

  private evict(): void {
    while (this.usedBytes > this.budgetBytes && this.map.size > 0) {
      const oldest = this.map.keys().next().value as string;
      const t = this.map.get(oldest)!;
      t.texture.destroy();
      this.usedBytes -= t.bytes;
      this.map.delete(oldest);
    }
  }
}
