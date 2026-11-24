/** 色带定义与采样, 0..1 区间映射 RGB 三元组 (0..1) */
export interface ColorStop {
  t: number;
  rgb: [number, number, number];
}

const RAMP_RDYLGN: ColorStop[] = [
  { t: 0.0, rgb: [0.647, 0.0, 0.149] },
  { t: 0.2, rgb: [0.937, 0.365, 0.282] },
  { t: 0.4, rgb: [0.996, 0.69, 0.38] },
  { t: 0.6, rgb: [0.996, 0.929, 0.627] },
  { t: 0.8, rgb: [0.631, 0.851, 0.608] },
  { t: 1.0, rgb: [0.0, 0.408, 0.216] },
];

const RAMP_VIRIDIS: ColorStop[] = [
  { t: 0.0, rgb: [0.267, 0.005, 0.329] },
  { t: 0.25, rgb: [0.282, 0.14, 0.458] },
  { t: 0.5, rgb: [0.128, 0.365, 0.506] },
  { t: 0.75, rgb: [0.157, 0.592, 0.486] },
  { t: 1.0, rgb: [0.993, 0.906, 0.144] },
];

const RAMP_JET: ColorStop[] = [
  { t: 0.0, rgb: [0.0, 0.0, 0.5] },
  { t: 0.25, rgb: [0.0, 0.5, 1.0] },
  { t: 0.5, rgb: [0.0, 1.0, 0.5] },
  { t: 0.75, rgb: [1.0, 0.5, 0.0] },
  { t: 1.0, rgb: [0.5, 0.0, 0.0] },
];

const RAMP_GRAY: ColorStop[] = [
  { t: 0.0, rgb: [0.05, 0.05, 0.05] },
  { t: 1.0, rgb: [0.95, 0.95, 0.95] },
];

export const COLORMAPS: Record<string, ColorStop[]> = {
  rdylgn: RAMP_RDYLGN,
  viridis: RAMP_VIRIDIS,
  jet: RAMP_JET,
  gray: RAMP_GRAY,
};

export function sampleColormap(name: string, t: number): [number, number, number] {
  const ramp = COLORMAPS[name] ?? RAMP_RDYLGN;
  const x = Math.min(1, Math.max(0, t));
  for (let i = 0; i < ramp.length - 1; i++) {
    const a = ramp[i];
    const b = ramp[i + 1];
    if (x <= b.t) {
      const f = (x - a.t) / Math.max(b.t - a.t, 1e-9);
      return [
        a.rgb[0] + (b.rgb[0] - a.rgb[0]) * f,
        a.rgb[1] + (b.rgb[1] - a.rgb[1]) * f,
        a.rgb[2] + (b.rgb[2] - a.rgb[2]) * f,
      ];
    }
  }
  return ramp[ramp.length - 1].rgb;
}

/** 生成 256 项查找表 (Uint8), 供 canvas 图例与 WGSL 纹理共同使用 */
export function buildLut(name: string): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256 * 4);
  for (let i = 0; i < 256; i++) {
    const [r, g, b] = sampleColormap(name, i / 255);
    lut[i * 4] = Math.round(r * 255);
    lut[i * 4 + 1] = Math.round(g * 255);
    lut[i * 4 + 2] = Math.round(b * 255);
    lut[i * 4 + 3] = 255;
  }
  return lut;
}
