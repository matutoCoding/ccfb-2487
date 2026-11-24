/**
 * 影像金字塔: level 0 为原始分辨率, 每升高一级 2x2 box 平均降采样。
 * 切片为平面存储 uint16 (5 波段), 与定标系数解耦:
 * 重新定标不需要重建金字塔, 定标在读取/上传 GPU 时应用。
 */
import { BAND_COUNT } from '../types';

export interface PyramidLevel {
  level: number;
  width: number;
  height: number;
  tilesX: number;
  tilesY: number;
}

export interface PyramidMeta {
  width: number;
  height: number;
  tileSize: number;
  levels: PyramidLevel[];
}

export function buildPyramidMeta(width: number, height: number, tileSize: number): PyramidMeta {
  const levels: PyramidLevel[] = [];
  let w = width;
  let h = height;
  let level = 0;
  while (true) {
    levels.push({
      level,
      width: w,
      height: h,
      tilesX: Math.ceil(w / tileSize),
      tilesY: Math.ceil(h / tileSize),
    });
    if (w <= tileSize && h <= tileSize) break;
    w = Math.max(1, Math.ceil(w / 2));
    h = Math.max(1, Math.ceil(h / 2));
    level++;
  }
  return { width, height, tileSize, levels };
}

/**
 * 对 level L 的整幅平面数据做 2x2 box 降采样, 生成 level L+1。
 * src: Float/Uint 平面数组 bands * w * h
 */
export function downsampleBox(src: Uint16Array, w: number, h: number): Uint16Array {
  const nw = Math.max(1, Math.ceil(w / 2));
  const nh = Math.max(1, Math.ceil(h / 2));
  const dst = new Uint16Array(nw * nh * BAND_COUNT);
  for (let y = 0; y < nh; y++) {
    const sy0 = y * 2;
    const sy1 = Math.min(h, sy0 + 2);
    for (let x = 0; x < nw; x++) {
      const sx0 = x * 2;
      const sx1 = Math.min(w, sx0 + 2);
      const n = (sy1 - sy0) * (sx1 - sx0);
      const dstOff = (y * nw + x) * BAND_COUNT;
      for (let b = 0; b < BAND_COUNT; b++) {
        let sum = 0;
        for (let sy = sy0; sy < sy1; sy++) {
          for (let sx = sx0; sx < sx1; sx++) {
            sum += src[(sy * w + sx) * BAND_COUNT + b];
          }
        }
        dst[dstOff + b] = Math.round(sum / n);
      }
    }
  }
  return dst;
}

/**
 * 从整幅平面源数据按 tile 切分 (边缘补 0)。
 * 返回每个 tile 的 Uint16Array (tileSize*tileSize*5, 平面)。
 */
export function sliceTiles(
  full: Uint16Array,
  fullW: number,
  fullH: number,
  tileSize: number,
): { tiles: Uint16Array[]; tilesX: number; tilesY: number } {
  const tilesX = Math.ceil(fullW / tileSize);
  const tilesY = Math.ceil(fullH / tileSize);
  const tiles: Uint16Array[] = [];
  for (let ty = 0; ty < tilesY; ty++) {
    for (let tx = 0; tx < tilesX; tx++) {
      const tile = new Uint16Array(tileSize * tileSize * BAND_COUNT);
      for (let y = 0; y < tileSize; y++) {
        const sy = ty * tileSize + y;
        if (sy >= fullH) continue;
        for (let x = 0; x < tileSize; x++) {
          const sx = tx * tileSize + x;
          if (sx >= fullW) continue;
          for (let b = 0; b < BAND_COUNT; b++) {
            tile[(y * tileSize + x) * BAND_COUNT + b] = full[(sy * fullW + sx) * BAND_COUNT + b];
          }
        }
      }
      tiles.push(tile);
    }
  }
  return { tiles, tilesX, tilesY };
}

/** 选最适合当前视口比例的金字塔层级 */
export function chooseLevel(meta: PyramidMeta, viewportScale: number): number {
  // viewportScale = 屏幕像素 / 影像像素; <1 表示缩小
  let level = 0;
  while (level < meta.levels.length - 1) {
    const scaleAtNext = viewportScale * Math.pow(2, level + 1);
    if (scaleAtNext >= 0.5) break;
    level++;
  }
  return level;
}
