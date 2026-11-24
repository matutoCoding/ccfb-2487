import type { AffineModel, Plot, PlotGridConfig, Rect } from '../types';

export const IDENTITY_AFFINE: AffineModel = { a: 1, b: 0, c: 0, d: 0, e: 1, f: 0 };

export function applyAffine(m: AffineModel, x: number, y: number): [number, number] {
  return [m.a * x + m.b * y + m.c, m.d * x + m.e * y + m.f];
}

export function invertAffine(m: AffineModel): AffineModel {
  const det = m.a * m.e - m.b * m.d;
  const inv = 1 / det;
  return {
    a: m.e * inv,
    b: -m.b * inv,
    c: (m.b * m.f - m.e * m.c) * inv,
    d: -m.d * inv,
    e: m.a * inv,
    f: (m.d * m.c - m.a * m.f) * inv,
  };
}

export function composeAffine(p: AffineModel, q: AffineModel): AffineModel {
  // 先 p 后 q: q(p(x))
  return {
    a: q.a * p.a + q.b * p.d,
    b: q.a * p.b + q.b * p.e,
    c: q.a * p.c + q.b * p.f + q.c,
    d: q.d * p.a + q.e * p.d,
    e: q.d * p.b + q.e * p.e,
    f: q.d * p.c + q.e * p.f + q.f,
  };
}

/** 由 >=3 对控制点最小二乘拟合仿射变换 (src -> dst) */
export function fitAffine(pairs: { sx: number; sy: number; dx: number; dy: number }[]): AffineModel {
  const n = pairs.length;
  if (n < 3) throw new Error('至少需要 3 个控制点拟合仿射变换');
  // 正规方程 A^T A (3x3, x/y 共享) 与两个右端项
  let sxx = 0,
    sxy = 0,
    sx = 0,
    syy = 0,
    sy = 0;
  let bxx = 0,
    bxy = 0,
    bx0 = 0;
  let byx = 0,
    byy = 0,
    by0 = 0;
  for (const { sx: x, sy: y, dx, dy } of pairs) {
    sxx += x * x;
    sxy += x * y;
    sx += x;
    syy += y * y;
    sy += y;
    bxx += x * dx;
    bxy += y * dx;
    bx0 += dx;
    byx += x * dy;
    byy += y * dy;
    by0 += dy;
  }
  const A = [
    [sxx, sxy, sx],
    [sxy, syy, sy],
    [sx, sy, n],
  ];
  const solX = solve3(A, [bxx, bxy, bx0]);
  const solY = solve3(A, [byx, byy, by0]);
  return { a: solX[0], b: solX[1], c: solX[2], d: solY[0], e: solY[1], f: solY[2] };
}

function solve3(A: number[][], b: number[]): number[] {
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < 3; col++) {
    let piv = col;
    for (let r = col + 1; r < 3; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    [M[col], M[piv]] = [M[piv], M[col]];
    const d = M[col][col];
    if (Math.abs(d) < 1e-12) throw new Error('控制点共线, 无法拟合仿射变换');
    for (let r = 0; r < 3; r++) {
      if (r === col) continue;
      const f = M[r][col] / d;
      for (let k = col; k <= 3; k++) M[r][k] -= f * M[col][k];
    }
  }
  return [M[0][3] / M[0][0], M[1][3] / M[1][1], M[2][3] / M[2][2]];
}

/** 根据田间种植图配置生成小区网格 (像素坐标, 角度可旋转, 支持行列微调) */
export function buildPlotGrid(cfg: PlotGridConfig): Plot[] {
  const angleRad = (cfg.angleDeg * Math.PI) / 180;
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  const plots: Plot[] = [];
  let idx = 0;
  for (let r = 0; r < cfg.rows; r++) {
    for (let c = 0; c < cfg.cols; c++) {
      // 未旋转的局部坐标 (小区中心)
      const lx = cfg.originX + c * (cfg.plotW + cfg.alleyX) + cfg.plotW / 2 + (cfg.rowOffsets[r] ?? 0);
      const ly = cfg.originY + r * (cfg.plotH + cfg.alleyY) + cfg.plotH / 2 + (cfg.colOffsets[c] ?? 0);
      const cx = cfg.originX + cos * (lx - cfg.originX) - sin * (ly - cfg.originY);
      const cy = cfg.originY + sin * (lx - cfg.originX) + cos * (ly - cfg.originY);
      plots.push({
        id: `plot_r${r + 1}c${c + 1}`,
        index: idx++,
        row: r,
        col: c,
        cx,
        cy,
        w: cfg.plotW,
        h: cfg.plotH,
        angleRad,
      });
    }
  }
  return plots;
}

/** 小区的四个角点 (顺时针, 像素坐标) */
export function plotCorners(p: Plot): [number, number][] {
  const hw = p.w / 2;
  const hh = p.h / 2;
  const cos = Math.cos(p.angleRad);
  const sin = Math.sin(p.angleRad);
  const local: [number, number][] = [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ];
  return local.map(([lx, ly]) => [p.cx + cos * lx - sin * ly, p.cy + sin * lx + cos * ly]);
}

/** 小区外接 AABB (用于粗裁剪与分块定位) */
export function plotAABB(p: Plot): Rect {
  const cs = plotCorners(p);
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const [x, y] of cs) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/**
 * 点是否在小区内部 (支持旋转)。
 * 把点变换到小区局部坐标系后做矩形判定, inset 为四周内缩像素。
 */
export function pointInPlot(p: Plot, x: number, y: number, inset = 0): boolean {
  const dx = x - p.cx;
  const dy = y - p.cy;
  const cos = Math.cos(-p.angleRad);
  const sin = Math.sin(-p.angleRad);
  const lx = cos * dx - sin * dy;
  const ly = sin * dx + cos * dy;
  return Math.abs(lx) <= p.w / 2 - inset && Math.abs(ly) <= p.h / 2 - inset;
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}
