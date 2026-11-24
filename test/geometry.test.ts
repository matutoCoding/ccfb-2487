import { describe, it, expect } from 'vitest';
import {
  buildPlotGrid,
  pointInPlot,
  plotCorners,
  fitAffine,
  invertAffine,
  applyAffine,
  composeAffine,
  IDENTITY_AFFINE,
} from '../src/core/geometry';
import type { PlotGridConfig } from '../src/types';

const baseCfg: PlotGridConfig = {
  rows: 4,
  cols: 5,
  plotW: 40,
  plotH: 20,
  alleyX: 8,
  alleyY: 6,
  originX: 10,
  originY: 10,
  angleDeg: 0,
  insetPx: 2,
  rowOffsets: {},
  colOffsets: {},
};

describe('小区网格', () => {
  it('行列数与编号正确', () => {
    const plots = buildPlotGrid(baseCfg);
    expect(plots).toHaveLength(20);
    expect(plots[0].row).toBe(0);
    expect(plots[0].col).toBe(0);
    expect(plots[19].row).toBe(3);
    expect(plots[19].col).toBe(4);
  });

  it('中心间距 = 小区尺寸 + 走道', () => {
    const plots = buildPlotGrid(baseCfg);
    expect(plots[1].cx - plots[0].cx).toBe(48);
    expect(plots[5].cy - plots[0].cy).toBe(26);
  });

  it('内缩点判定', () => {
    const plots = buildPlotGrid(baseCfg);
    const p = plots[0];
    expect(pointInPlot(p, p.cx, p.cy)).toBe(true);
    expect(pointInPlot(p, p.cx + p.w / 2 - 1, p.cy)).toBe(true);
    expect(pointInPlot(p, p.cx + p.w / 2 + 1, p.cy)).toBe(false);
    expect(pointInPlot(p, p.cx, p.cy, 2)).toBe(true);
    expect(pointInPlot(p, p.cx + p.w / 2 - 1, p.cy, 2)).toBe(false);
  });

  it('旋转 90 度后角点位置正确', () => {
    const plots = buildPlotGrid({ ...baseCfg, angleDeg: 90 });
    const p = plots[0];
    const corners = plotCorners(p);
    const xs = corners.map((c) => c[0]);
    const ys = corners.map((c) => c[1]);
    // 旋转后宽高互换
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(p.h, 6);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(p.w, 6);
  });

  it('单行微调生效', () => {
    const plots = buildPlotGrid({ ...baseCfg, rowOffsets: { 0: 12 } });
    expect(plots[0].cx - buildPlotGrid(baseCfg)[0].cx).toBe(12);
    expect(plots[5].cx).toBe(buildPlotGrid(baseCfg)[5].cx);
  });
});

describe('仿射变换', () => {
  it('求逆互逆', () => {
    const m = { a: 2, b: 0.5, c: 10, d: -0.3, e: 1.7, f: -4 };
    const inv = invertAffine(m);
    const [x, y] = applyAffine(m, 3.2, -1.7);
    const [rx, ry] = applyAffine(inv, x, y);
    expect(rx).toBeCloseTo(3.2, 10);
    expect(ry).toBeCloseTo(-1.7, 10);
  });

  it('控制点拟合恢复已知仿射', () => {
    const truth = { a: 1.02, b: 0.03, c: -5, d: -0.02, e: 0.98, f: 7 };
    const pairs = [
      [0, 0], [100, 0], [0, 100], [100, 100], [50, 30],
    ].map(([sx, sy]) => {
      const [dx, dy] = applyAffine(truth, sx, sy);
      return { sx, sy, dx, dy };
    });
    const fit = fitAffine(pairs);
    expect(fit.a).toBeCloseTo(truth.a, 9);
    expect(fit.b).toBeCloseTo(truth.b, 9);
    expect(fit.c).toBeCloseTo(truth.c, 9);
    expect(fit.d).toBeCloseTo(truth.d, 9);
    expect(fit.e).toBeCloseTo(truth.e, 9);
    expect(fit.f).toBeCloseTo(truth.f, 9);
  });

  it('不足 3 点拒绝拟合', () => {
    expect(() => fitAffine([{ sx: 0, sy: 0, dx: 1, dy: 1 }])).toThrow();
  });

  it('复合变换 = 逐次应用', () => {
    const p = { a: 1, b: 0, c: 10, d: 0, e: 1, f: 0 };
    const q = { a: 2, b: 0, c: 0, d: 0, e: 2, f: 0 };
    const m = composeAffine(p, q);
    expect(applyAffine(m, 5, 7)).toEqual([30, 14]);
    expect(applyAffine(IDENTITY_AFFINE, 3, 4)).toEqual([3, 4]);
  });
});
