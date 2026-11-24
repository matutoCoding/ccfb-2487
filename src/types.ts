// 领域类型定义 —— 全系统共享
export const BAND_NAMES = ['B', 'G', 'R', 'RE', 'NIR'] as const;
export type BandName = (typeof BAND_NAMES)[number];
export const BAND_COUNT = 5;

export const BAND_INDEX: Record<BandName, number> = { B: 0, G: 1, R: 2, RE: 3, NIR: 4 };

export interface Experiment {
  id: string;
  name: string;
  crop: string;
  season: string;
  design: 'RCBD' | 'RANDOM' | 'GRID';
  notes?: string;
  createdAt: number;
}

/** 二维仿射: [x';y'] = [[a,b],[d,e]] [x;y] + [c;f]，像素坐标 */
export interface AffineModel {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 定标板观测: 影像上的 ROI 与该板已知的五波段反射率(0..1) */
export interface CalibrationPanelInput {
  rect: Rect;
  reflectance: number[]; // 长度 5
}

export interface CalibrationPanelFit extends CalibrationPanelInput {
  meanDN: number[]; // 长度 5, ROI 内各波段 DN 均值
}

export interface Calibration {
  id: string;
  experimentId: string;
  imageId: string;
  date: string;
  /** refl = gain * DN + offset，每波段一组 */
  gains: number[];
  offsets: number[];
  r2: number[];
  panels: CalibrationPanelFit[];
  createdAt: number;
}

export interface FlightImage {
  id: string;
  experimentId: string;
  date: string; // YYYY-MM-DD
  name: string;
  width: number;
  height: number;
  tileSize: number;
  levels: number;
  dtype: 'uint16';
  bands: BandName[];
  calibrationId?: string;
  /** 相对于基准影像(试验内最早影像)的配准变换: 基准坐标 -> 本影像坐标 */
  registration?: AffineModel;
  gsd: number; // 米/像素
  importedAt: number;
}

export interface PlotGridConfig {
  rows: number;
  cols: number;
  plotW: number; // 像素
  plotH: number;
  alleyX: number; // 列间走道宽
  alleyY: number; // 行间走道宽
  originX: number;
  originY: number;
  angleDeg: number;
  insetPx: number; // 四周内缩, 去边行效应
  rowOffsets: Record<number, number>; // 单行微调 (row -> dx)
  colOffsets: Record<number, number>; // 单列微调 (col -> dy)
}

export interface Plot {
  id: string;
  index: number;
  row: number;
  col: number;
  cx: number;
  cy: number;
  w: number;
  h: number;
  angleRad: number;
  genotype?: string;
  replicate?: number;
  isCheck?: boolean;
}

export interface DesignRow {
  experimentId: string;
  row: number;
  col: number;
  genotype: string;
  replicate: number;
  isCheck: boolean;
}

export interface MaskThresholds {
  soilNDVI: number; // NDVI 低于此值判为土壤
  cloudBright: number; // 可见光平均反射率高于此值判为云
  shadowDark: number; // 可见光平均反射率低于此值判为阴影
}

export const DEFAULT_MASK_THRESHOLDS: MaskThresholds = {
  soilNDVI: 0.25,
  cloudBright: 0.55,
  shadowDark: 0.08,
};

export interface PlotStats {
  plotId: string;
  imageId: string;
  indexName: string;
  totalPixels: number; // 内缩区内总像素
  vegPixels: number; // 植被有效像素
  cloudShadowPixels: number; // 云/影像素
  mean: number;
  median: number;
  min: number;
  max: number;
  coverage: number; // vegPixels / totalPixels
  cloudShadowFraction: number;
  flagged: boolean; // 云影占比超阈值 -> 不参与汇总
}

export interface BandExpression {
  name: string;
  label: string;
  expr: string;
  builtin: boolean;
}

export const BUILTIN_EXPRESSIONS: BandExpression[] = [
  { name: 'NDVI', label: '归一化植被指数 NDVI', expr: '(NIR - R) / (NIR + R)', builtin: true },
  { name: 'NDRE', label: '红边归一化指数 NDRE', expr: '(NIR - RE) / (NIR + RE)', builtin: true },
  { name: 'GNDVI', label: '绿光归一化指数 GNDVI', expr: '(NIR - G) / (NIR + G)', builtin: true },
  { name: 'EVI', label: '增强植被指数 EVI', expr: '2.5 * (NIR - R) / (NIR + 6 * R - 7.5 * B + 1)', builtin: true },
  { name: 'OSAVI', label: '优化土壤调节指数 OSAVI', expr: '1.16 * (NIR - R) / (NIR + R + 0.16)', builtin: true },
  { name: 'SAVI', label: '土壤调节指数 SAVI', expr: '1.5 * (NIR - R) / (NIR + R + 0.5)', builtin: true },
];

export interface AppSettings {
  mask: MaskThresholds;
  gpuMemoryBudgetMB: number; // GPU 纹理缓存预算
  ramCacheBudgetMB: number; // 内存切片缓存预算
  tileSize: number;
  colormap: string;
  flagCloudShadowFraction: number; // 云影占比超过此值则标记小区
  histogramLowPct: number; // 色带拉伸低端百分位
  histogramHighPct: number;
}

export const DEFAULT_SETTINGS: AppSettings = {
  mask: { ...DEFAULT_MASK_THRESHOLDS },
  gpuMemoryBudgetMB: 320,
  ramCacheBudgetMB: 96,
  tileSize: 256,
  colormap: 'rdylgn',
  flagCloudShadowFraction: 0.1,
  histogramLowPct: 2,
  histogramHighPct: 98,
};

export interface GcpPoint {
  id: string;
  baseX: number;
  baseY: number;
  imageX: number;
  imageY: number;
}
