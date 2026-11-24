import { describe, it, expect } from 'vitest';
import {
  oneWayAnova,
  fSurvival,
  estimateHeadingDate,
  percentileFromHistogram,
  computePlotStatsCpu,
  type CpuRaster,
} from '../src/core/stats';
import { compileExpression } from '../src/core/expression';
import { buildPlotGrid } from '../src/core/geometry';
import { DEFAULT_MASK_THRESHOLDS } from '../src/types';

describe('单因素方差分析', () => {
  it('组间无差异时 F 接近 1, p 接近 1', () => {
    const groups = Array.from({ length: 5 }, (_, g) => ({
      genotype: `G${g}`,
      values: Array.from({ length: 20 }, (_, i) => 0.5 + 0.01 * Math.sin(i + g)),
    }));
    const r = oneWayAnova(groups, 'NDVI', '2026-05-01', new Set());
    expect(r.f).toBeGreaterThan(0);
    expect(r.p).toBeGreaterThan(0.5);
    expect(r.dfBetween).toBe(4);
    expect(r.dfWithin).toBe(95);
  });

  it('组间差异显著时 p 很小', () => {
    const groups = Array.from({ length: 6 }, (_, g) => ({
      genotype: `G${g}`,
      values: Array.from({ length: 30 }, (_, i) => g * 0.1 + 0.005 * Math.sin(i)),
    }));
    const r = oneWayAnova(groups, 'NDVI', '2026-05-01', new Set(['G0']));
    expect(r.p).toBeLessThan(1e-10);
    expect(r.groups[0].isCheck).toBe(false);
    expect(r.groups.find((x) => x.genotype === 'G0')?.isCheck).toBe(true);
    expect(r.groups[0].genotype).toBe('G5'); // 均值降序
    expect(Number.isFinite(r.lsd05)).toBe(true);
  });

  it('F 生存函数与教科书临界值一致', () => {
    // F(5,10) 0.05 临界值 = 3.326
    expect(fSurvival(3.326, 5, 10)).toBeCloseTo(0.05, 2);
    // F(2,30) 0.05 = 3.316
    expect(fSurvival(3.316, 2, 30)).toBeCloseTo(0.05, 2);
    // F(10,10) 0.01 = 4.849
    expect(fSurvival(4.849, 10, 10)).toBeCloseTo(0.01, 2);
  });
});

describe('直方图百分位', () => {
  it('均匀分布百分位线性', () => {
    const hist = new Uint32Array(100).fill(10);
    expect(percentileFromHistogram(hist, 0, 1, 50)).toBeCloseTo(0.5, 5);
    expect(percentileFromHistogram(hist, 0, 1, 10)).toBeCloseTo(0.1, 5);
  });
});

describe('抽穗期估计', () => {
  it('在拐点日期附近', () => {
    // 模拟 NDVI: 快速上升 -> 平台 -> 下降, 拐点在第 30 天附近
    const series = [0, 10, 20, 28, 35, 45, 60, 75].map((t, i) => ({
      date: '2026-03-01',
      t,
      value: [0.2, 0.35, 0.55, 0.72, 0.8, 0.83, 0.82, 0.7][i],
    }));
    const h = estimateHeadingDate(series);
    expect(h).not.toBeNull();
    expect(h!.t).toBeGreaterThan(15);
    expect(h!.t).toBeLessThan(45);
  });

  it('点数不足返回 null', () => {
    expect(estimateHeadingDate([{ date: '2026-03-01', t: 0, value: 0.2 }])).toBeNull();
  });
});

describe('CPU 逐像素参考统计', () => {
  function makeRaster(width: number, height: number, fill: (x: number, y: number, b: number) => number): CpuRaster {
    const bands = Array.from({ length: 5 }, () => new Float32Array(width * height));
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) for (let b = 0; b < 5; b++) bands[b][y * width + x] = fill(x, y, b);
    return { width, height, bands };
  }

  it('均匀植被小区: 均值/中位数/覆盖度正确且不被标记', () => {
    const W = 120;
    const H = 120;
    const refl = [0.08, 0.13, 0.09, 0.25, 0.5];
    const raster = makeRaster(W, H, (_x, _y, b) => refl[b]);
    const plots = buildPlotGrid({
      rows: 1, cols: 1, plotW: 80, plotH: 60, alleyX: 0, alleyY: 0,
      originX: 20, originY: 30, angleDeg: 0, insetPx: 4, rowOffsets: {}, colOffsets: {},
    });
    const expr = compileExpression('(NIR - R) / (NIR + R)');
    const stats = computePlotStatsCpu(raster, plots[0], 4, DEFAULT_MASK_THRESHOLDS, expr.eval, 'img', 'NDVI', 0.1);
    const expected = expr.eval(refl);
    expect(stats.mean).toBeCloseTo(expected, 6);
    expect(stats.median).toBeCloseTo(expected, 6);
    expect(stats.coverage).toBeCloseTo(1, 4);
    expect(stats.flagged).toBe(false);
    expect(stats.vegPixels).toBe((80 - 8) * (60 - 8));
  });

  it('阴影像素被剔除并计入 cloudShadowPixels', () => {
    const W = 60;
    const H = 60;
    const vegRefl = [0.08, 0.13, 0.09, 0.25, 0.5];
    const r2 = makeRaster(W, H, (x, y, b) => (x < 30 && y < 30 ? [0.02, 0.02, 0.02, 0.02, 0.02][b] : vegRefl[b]));
    const plots = buildPlotGrid({
      rows: 1, cols: 1, plotW: 50, plotH: 50, alleyX: 0, alleyY: 0,
      originX: 5, originY: 5, angleDeg: 0, insetPx: 0, rowOffsets: {}, colOffsets: {},
    });
    const expr = compileExpression('(NIR - R) / (NIR + R)');
    const stats = computePlotStatsCpu(r2, plots[0], 0, DEFAULT_MASK_THRESHOLDS, expr.eval, 'img', 'NDVI', 0.1);
    expect(stats.cloudShadowPixels).toBe(25 * 25);
    expect(stats.vegPixels).toBe(50 * 50 - 25 * 25);
    expect(stats.flagged).toBe(true); // 阴影占比 25% > 10%
  });

  it('土壤像素 (低 NDVI) 不参与均值', () => {
    const W = 40;
    const H = 40;
    // 一半裸土 (红 > 近红, NDVI 为负), 一半植被
    const soilRefl = [0.2, 0.18, 0.22, 0.2, 0.18];
    const vegRefl = [0.08, 0.13, 0.09, 0.25, 0.5];
    const raster = makeRaster(W, H, (x, _y, b) => (x < 20 ? soilRefl[b] : vegRefl[b]));
    const plots = buildPlotGrid({
      rows: 1, cols: 1, plotW: 40, plotH: 40, alleyX: 0, alleyY: 0,
      originX: 0, originY: 0, angleDeg: 0, insetPx: 0, rowOffsets: {}, colOffsets: {},
    });
    const expr = compileExpression('(NIR - R) / (NIR + R)');
    const stats = computePlotStatsCpu(raster, plots[0], 0, DEFAULT_MASK_THRESHOLDS, expr.eval, 'img', 'NDVI', 0.1);
    expect(stats.vegPixels).toBe(20 * 40);
    expect(stats.mean).toBeCloseTo(expr.eval(vegRefl), 5);
  });
});
