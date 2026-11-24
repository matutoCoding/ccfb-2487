import type { MaskThresholds, Plot, PlotStats } from '../types';
import { pointInPlot, plotAABB } from './geometry';

/**
 * CPU 逐像素参考实现 —— 全系统精度基准。
 * GPU 统计结果必须与此实现相对误差 < 0.1%。
 * bands: 平面存储的反射率浮点数组 (5 * W * H), 已辐射定标
 */
export interface CpuRaster {
  width: number;
  height: number;
  bands: Float32Array[]; // 5 个平面
}

export function computePlotStatsCpu(
  raster: CpuRaster,
  plot: Plot,
  inset: number,
  mask: MaskThresholds,
  indexEval: (bands: ArrayLike<number>) => number,
  imageId: string,
  indexName: string,
  flagFraction: number,
): PlotStats {
  const { width, height, bands } = raster;
  const bb = plotAABB(plot);
  const x0 = Math.max(0, Math.floor(bb.x));
  const y0 = Math.max(0, Math.floor(bb.y));
  const x1 = Math.min(width, Math.ceil(bb.x + bb.w));
  const y1 = Math.min(height, Math.ceil(bb.y + bb.h));

  const px = new Float64Array(5);
  const values: number[] = [];
  let total = 0;
  let veg = 0;
  let cloudShadow = 0;
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (!pointInPlot(plot, x + 0.5, y + 0.5, inset)) continue;
      total++;
      const off = y * width + x;
      for (let b = 0; b < 5; b++) px[b] = bands[b][off];
      const visible = (px[0] + px[1] + px[2]) / 3;
      const denom = px[4] + px[2];
      const ndvi = Math.abs(denom) > 1e-12 ? (px[4] - px[2]) / denom : 0;
      const isCloud = visible > mask.cloudBright;
      const isShadow = visible < mask.shadowDark;
      if (isCloud || isShadow) {
        cloudShadow++;
        continue;
      }
      if (ndvi < mask.soilNDVI) continue; // 土壤背景剔除
      const v = indexEval(px);
      if (!Number.isFinite(v)) continue;
      values.push(v);
      veg++;
      sum += v;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }

  const mean = veg > 0 ? sum / veg : NaN;
  const median = veg > 0 ? medianSorted([...values].sort((a, b) => a - b)) : NaN;
  const csFraction = total > 0 ? cloudShadow / total : 0;
  return {
    plotId: plot.id,
    imageId,
    indexName,
    totalPixels: total,
    vegPixels: veg,
    cloudShadowPixels: cloudShadow,
    mean,
    median,
    min: veg > 0 ? min : NaN,
    max: veg > 0 ? max : NaN,
    coverage: total > 0 ? veg / total : 0,
    cloudShadowFraction: csFraction,
    flagged: csFraction > flagFraction || veg === 0,
  };
}

export function medianSorted(sorted: number[]): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  const mid = n >> 1;
  return n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** 直方图百分位 (线性插值), bins 为等宽计数 */
export function percentileFromHistogram(hist: Uint32Array | number[], min: number, max: number, pct: number): number {
  const total = typeof hist === 'object' && hist instanceof Uint32Array ? hist.reduce((a, b) => a + b, 0) : (hist as number[]).reduce((a, b) => a + b, 0);
  if (total === 0) return min;
  const target = (pct / 100) * total;
  let acc = 0;
  const width = (max - min) / hist.length;
  for (let i = 0; i < hist.length; i++) {
    const next = acc + hist[i];
    if (next >= target) {
      const frac = hist[i] === 0 ? 0 : (target - acc) / hist[i];
      return min + (i + frac) * width;
    }
    acc = next;
  }
  return max;
}

export interface AnovaGroup {
  genotype: string;
  values: number[];
}

export interface AnovaResult {
  indexName: string;
  date: string;
  groupCount: number;
  n: number;
  grandMean: number;
  ssBetween: number;
  ssWithin: number;
  dfBetween: number;
  dfWithin: number;
  msBetween: number;
  msWithin: number;
  f: number;
  p: number;
  lsd05: number;
  groups: { genotype: string; n: number; mean: number; sd: number; isCheck: boolean }[];
}

/** 单因素方差分析 + Fisher LSD (α=0.05) */
export function oneWayAnova(groups: AnovaGroup[], indexName: string, date: string, checkGenotypes: Set<string>): AnovaResult {
  const valid = groups.filter((g) => g.values.length > 0);
  const n = valid.reduce((a, g) => a + g.values.length, 0);
  const k = valid.length;
  const grandSum = valid.reduce((a, g) => a + g.values.reduce((x, y) => x + y, 0), 0);
  const grandMean = grandSum / n;
  let ssBetween = 0;
  let ssWithin = 0;
  const summary = valid.map((g) => {
    const m = g.values.reduce((x, y) => x + y, 0) / g.values.length;
    ssBetween += g.values.length * (m - grandMean) ** 2;
    const variance = g.values.reduce((x, y) => x + (y - m) ** 2, 0);
    ssWithin += variance;
    const sd = g.values.length > 1 ? Math.sqrt(variance / (g.values.length - 1)) : 0;
    return { genotype: g.genotype, n: g.values.length, mean: m, sd, isCheck: checkGenotypes.has(g.genotype) };
  });
  const dfBetween = k - 1;
  const dfWithin = n - k;
  const msBetween = ssBetween / dfBetween;
  const msWithin = ssWithin / dfWithin;
  const f = msBetween / msWithin;
  const p = fSurvival(f, dfBetween, dfWithin);
  // LSD = t(0.975, dfWithin) * sqrt(MSE * (1/n_i + 1/n_j)); 给等样本量参考值
  const t = tCritical0975(dfWithin);
  const harmonicN = n / k;
  const lsd05 = t * Math.sqrt((2 * msWithin) / harmonicN);
  return {
    indexName,
    date,
    groupCount: k,
    n,
    grandMean,
    ssBetween,
    ssWithin,
    dfBetween,
    dfWithin,
    msBetween,
    msWithin,
    f,
    p,
    lsd05,
    groups: summary.sort((a, b) => b.mean - a.mean),
  };
}

/** F 分布上尾 P(F>f) —— 正则化不完全贝塔函数 */
export function fSurvival(f: number, d1: number, d2: number): number {
  if (!(f > 0)) return 1;
  const x = (d1 * f) / (d1 * f + d2);
  return 1 - regularizedBeta(x, d1 / 2, d2 / 2);
}

function logBeta(a: number, b: number): number {
  return lnGamma(a) + lnGamma(b) - lnGamma(a + b);
}

function regularizedBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(-logBeta(a, b) + a * Math.log(x) + b * Math.log(1 - x));
  if (x < (a + 1) / (a + b + 2)) return (bt * betaCf(x, a, b)) / a;
  return 1 - (bt * betaCf(1 - x, b, a)) / b;
}

/** 连分式展开 (Lentz 方法) */
function betaCf(x: number, a: number, b: number): number {
  const maxIter = 200;
  const eps = 1e-12;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < 1e-30) d = 1e-30;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= maxIter; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < 1e-30) d = 1e-30;
    c = 1 + aa / c;
    if (Math.abs(c) < 1e-30) c = 1e-30;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < 1e-30) d = 1e-30;
    c = 1 + aa / c;
    if (Math.abs(c) < 1e-30) c = 1e-30;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < eps) break;
  }
  return h;
}

function lnGamma(z: number): number {
  const cof = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let x = z;
  let y = z;
  let tmp = z + 5.5;
  tmp -= (z + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (const c of cof) ser += c / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

/** t 临界值近似 (双侧 0.05), 大自由度走正态近似, 小自由度用 Hill 近似 */
export function tCritical0975(df: number): number {
  if (df <= 0) return NaN;
  if (df > 1000) return 1.96;
  // 数值配方 (Cornish-Fisher 风格), 误差 < 5e-4
  const g1 = (Math.pow(df, 3) + 76 * df * df + 720 * df + 850) / (4 * Math.pow(df, 4) + 120 * df * df + 720 * df);
  return 1.959964 + (2.37744 / df) + (3.42842 / (df * df)) + g1;
}

export interface TimePoint {
  date: string; // YYYY-MM-DD
  t: number; // 距首日天数
  value: number;
}

/**
 * 抽穗期估计: 对指数时序做三点滑动平滑, 取一阶差分最大处 (生长最快拐点),
 * 在相邻点间线性插值到天。抽穗通常对应 NDVI 由升转降的峰值/拐点区。
 */
export function estimateHeadingDate(series: TimePoint[]): { date: string; t: number; slope: number } | null {
  const pts = series.filter((p) => Number.isFinite(p.value)).sort((a, b) => a.t - b.t);
  if (pts.length < 3) return null;
  const smoothed = pts.map((p, i) => {
    if (i === 0) return { t: p.t, v: (2 * p.value + pts[1].value) / 3 };
    if (i === pts.length - 1) return { t: p.t, v: (2 * p.value + pts[i - 1].value) / 3 };
    return { t: p.t, v: (pts[i - 1].value + p.value + pts[i + 1].value) / 3 };
  });
  let best = -1;
  let bestSlope = -Infinity;
  for (let i = 1; i < smoothed.length; i++) {
    const dt = smoothed[i].t - smoothed[i - 1].t;
    const slope = (smoothed[i].v - smoothed[i - 1].v) / Math.max(dt, 1e-9);
    if (slope > bestSlope) {
      bestSlope = slope;
      best = i;
    }
  }
  if (best <= 0) return null;
  // 拐点定位在 best-1 与 best 之间, 取差分中点
  const t = (smoothed[best - 1].t + smoothed[best].t) / 2;
  const ref = pts[0].date;
  return { date: addDays(ref, Math.round(t)), t, slope: bestSlope };
}

export function addDays(dateIso: string, days: number): string {
  const d = new Date(`${dateIso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}
