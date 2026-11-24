import type { FlightImage } from '../../types';
import { buildPyramidMeta, chooseLevel } from '../../io/pyramid';

/** 影像相机: 以 level0 像素为世界坐标 */
export interface Camera {
  centerX: number;
  centerY: number;
  scale: number; // 屏幕像素 / level0 像素
}

export function fitCamera(image: FlightImage, viewW: number, viewH: number): Camera {
  const margin = 0.92;
  const scale = Math.min((viewW * margin) / image.width, (viewH * margin) / image.height);
  return { centerX: image.width / 2, centerY: image.height / 2, scale };
}

export function clampScale(scale: number): number {
  return Math.min(40, Math.max(1 / 256, scale));
}

/** 世界坐标 (level0) -> 屏幕 */
export function worldToScreen(cam: Camera, viewW: number, viewH: number, x: number, y: number): [number, number] {
  return [viewW / 2 + (x - cam.centerX) * cam.scale, viewH / 2 + (y - cam.centerY) * cam.scale];
}
/** 屏幕 -> 世界坐标 */
export function screenToWorld(cam: Camera, viewW: number, viewH: number, sx: number, sy: number): [number, number] {
  return [cam.centerX + (sx - viewW / 2) / cam.scale, cam.centerY + (sy - viewH / 2) / cam.scale];
}

export interface VisibleTile {
  level: number;
  tx: number;
  ty: number;
  screenX: number;
  screenY: number;
  size: number;
  originLevelX: number;
  originLevelY: number;
}

/** 计算当前视口可见切片及其实例化绘制参数 */
export function computeVisibleTiles(image: FlightImage, cam: Camera, viewW: number, viewH: number): VisibleTile[] {
  const meta = buildPyramidMeta(image.width, image.height, image.tileSize);
  const level = chooseLevel(meta, cam.scale);
  const lvl = meta.levels[level];
  const levelFactor = Math.pow(2, level); // level 像素 = level0 / levelFactor
  const scaleAtLevel = cam.scale * levelFactor;
  // 视口在 level 坐标系中的范围
  const halfW = viewW / 2 / scaleAtLevel;
  const halfH = viewH / 2 / scaleAtLevel;
  const centerLevelX = cam.centerX / levelFactor;
  const centerLevelY = cam.centerY / levelFactor;
  const x0 = Math.max(0, Math.floor((centerLevelX - halfW) / image.tileSize));
  const y0 = Math.max(0, Math.floor((centerLevelY - halfH) / image.tileSize));
  const x1 = Math.min(lvl.tilesX - 1, Math.floor((centerLevelX + halfW) / image.tileSize));
  const y1 = Math.min(lvl.tilesY - 1, Math.floor((centerLevelY + halfH) / image.tileSize));
  const size = image.tileSize * scaleAtLevel;
  const out: VisibleTile[] = [];
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      const originLevelX = tx * image.tileSize;
      const originLevelY = ty * image.tileSize;
      const worldX = originLevelX * levelFactor;
      const worldY = originLevelY * levelFactor;
      const [screenX, screenY] = worldToScreen(cam, viewW, viewH, worldX, worldY);
      out.push({ level, tx, ty, screenX, screenY, size, originLevelX, originLevelY });
    }
  }
  return out;
}
