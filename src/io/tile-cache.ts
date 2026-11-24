/**
 * 切片内存缓存: 按预算 (字节) LRU 淘汰。
 * 三景大图切换时, 旧影像切片被换出, 内存占用有硬上限 —— 防止浏览器内存涨爆。
 */
interface CacheEntry {
  key: string;
  data: Uint16Array;
  bytes: number;
  lastUsed: number;
}

export class TileCache {
  private map = new Map<string, CacheEntry>();
  private usedBytes = 0;
  private clock = 0;

  constructor(private budgetBytes: number) {}

  setBudget(bytes: number): void {
    this.budgetBytes = bytes;
    this.evict();
  }

  get(key: string): Uint16Array | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    e.lastUsed = ++this.clock;
    // Map 的迭代顺序即插入顺序; get 后重新插入以维持 LRU
    this.map.delete(key);
    this.map.set(key, e);
    return e.data;
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  put(key: string, data: Uint16Array): void {
    const bytes = data.byteLength;
    if (this.map.has(key)) {
      const old = this.map.get(key)!;
      this.usedBytes -= old.bytes;
      this.map.delete(key);
    }
    this.map.set(key, { key, data, bytes, lastUsed: ++this.clock });
    this.usedBytes += bytes;
    this.evict();
  }

  /** 主动丢弃某影像的全部缓存 (切换/删除影像时调用) */
  evictImage(imageId: string): void {
    const prefix = `${imageId}/`;
    for (const key of [...this.map.keys()]) {
      if (key.startsWith(prefix)) {
        const e = this.map.get(key)!;
        this.usedBytes -= e.bytes;
        this.map.delete(key);
      }
    }
  }

  clear(): void {
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
      const e = this.map.get(oldest)!;
      this.usedBytes -= e.bytes;
      this.map.delete(oldest);
    }
  }
}
