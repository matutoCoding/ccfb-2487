import { describe, it, expect } from 'vitest';
import { fitBandRegression, fitCalibration, validateCalibration } from '../src/core/calibration';
import type { CalibrationPanelFit } from '../src/types';

describe('辐射定标', () => {
  it('单板过原点', () => {
    const r = fitBandRegression([5000], [0.5]);
    expect(r.gain).toBeCloseTo(0.0001, 10);
    expect(r.offset).toBe(0);
  });

  it('多板线性拟合恢复 gain/offset', () => {
    const gain = 0.00012;
    const offset = 0.02;
    const dn = [1000, 3000, 6000, 9000];
    const refl = dn.map((d) => gain * d + offset);
    const r = fitBandRegression(dn, refl);
    expect(r.gain).toBeCloseTo(gain, 12);
    expect(r.offset).toBeCloseTo(offset, 10);
    expect(r.r2).toBeCloseTo(1, 10);
  });

  it('五波段独立拟合与门控', () => {
    const panels: CalibrationPanelFit[] = [0.1, 0.3, 0.6].map((refl0) => ({
      rect: { x: 0, y: 0, w: 1, h: 1 },
      reflectance: [refl0, refl0, refl0, refl0, refl0],
      meanDN: [1000, 2000, 3000, 4000, 5000],
    }));
    const fit = fitCalibration(panels);
    expect(fit.gains).toHaveLength(5);
    expect(validateCalibration(fit.r2)).toBeNull();
    const bad = fit.r2.map((v, i) => (i === 2 ? 0.5 : v));
    expect(validateCalibration(bad)).toContain('R²');
  });
});
