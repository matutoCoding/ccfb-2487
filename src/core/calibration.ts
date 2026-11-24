import type { CalibrationPanelFit } from '../types';
import { BAND_COUNT } from '../types';

/**
 * 辐射定标: 由定标板 ROI 的 DN 均值与已知反射率, 逐波段最小二乘拟合
 *   reflectance = gain * DN + offset
 * 单板时退化为过原点线性 (offset=0)。
 */
export interface BandRegression {
  gain: number;
  offset: number;
  r2: number;
}

export function fitBandRegression(dn: number[], refl: number[]): BandRegression {
  const n = dn.length;
  if (n === 0) throw new Error('没有定标板观测数据');
  if (n === 1) {
    const gain = dn[0] !== 0 ? refl[0] / dn[0] : 0;
    return { gain, offset: 0, r2: 1 };
  }
  const meanX = dn.reduce((a, b) => a + b, 0) / n;
  const meanY = refl.reduce((a, b) => a + b, 0) / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (dn[i] - meanX) ** 2;
    sxy += (dn[i] - meanX) * (refl[i] - meanY);
    syy += (refl[i] - meanY) ** 2;
  }
  const gain = sxx > 0 ? sxy / sxx : 0;
  const offset = meanY - gain * meanX;
  const r2 = sxx > 0 && syy > 0 ? (sxy * sxy) / (sxx * syy) : 1;
  return { gain, offset, r2 };
}

export function fitCalibration(panels: CalibrationPanelFit[]): { gains: number[]; offsets: number[]; r2: number[] } {
  if (panels.length === 0) throw new Error('至少需要一块定标板');
  const gains = new Array(BAND_COUNT);
  const offsets = new Array(BAND_COUNT);
  const r2 = new Array(BAND_COUNT);
  for (let b = 0; b < BAND_COUNT; b++) {
    const dn = panels.map((p) => p.meanDN[b]);
    const refl = panels.map((p) => p.reflectance[b]);
    const reg = fitBandRegression(dn, refl);
    gains[b] = reg.gain;
    offsets[b] = reg.offset;
    r2[b] = reg.r2;
  }
  return { gains, offsets, r2 };
}

/** 定标质量门控: R² 过低拒绝, 保证下游反射率可信 */
export function validateCalibration(r2: number[], minR2 = 0.9): string | null {
  for (let b = 0; b < r2.length; b++) {
    if (!Number.isFinite(r2[b]) || r2[b] < minR2) {
      return `波段 ${b} 定标 R²=${r2[b].toFixed(4)} 低于门限 ${minR2}, 请检查定标板 ROI 与反射率输入`;
    }
  }
  return null;
}

export function applyCalibrationLine(gain: number, offset: number, dn: number): number {
  return gain * dn + offset;
}
