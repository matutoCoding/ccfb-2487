import { BAND_COUNT, type FlightImage } from '../types';
import { mulberry32, clampUint16 } from '../core/util';
import { writeTiledTiff } from '../io/tiff-writer';

/**
 * 合成五波段无人机正射影像生成器 (可复现)。
 * 场景要素:
 *  - 规则小区阵列, 每个小区有独立品系反射率特征 + 行播作物纹理
 *  - 田埂/走道 (低反射裸土)
 *  - 一块多灰度定标板 (4 档反射率, 每档全波段相同)
 *  - 一块云 (高反射) + 一片投影阴影 (低反射)
 *  - 行间土壤 + 相机噪声
 */

export interface SyntheticSceneParams {
  width?: number;
  height?: number;
  tileSize?: number;
  rows?: number;
  cols?: number;
  plotW?: number;
  plotH?: number;
  alleyX?: number;
  alleyY?: number;
  originX?: number;
  originY?: number;
  seed?: number;
  /** 日期序号, 用于模拟生育期差异 (不同飞行日期) */
  growthStage?: number; // 0..1
  gsd?: number;
}

export interface SyntheticScene {
  data: Uint16Array;
  width: number;
  height: number;
  tileSize: number;
  bands: number;
  panelRect: { x: number; y: number; w: number; h: number };
  panelLevels: number[]; // 4 档反射率
  cloud: { x: number; y: number; rx: number; ry: number };
  shadow: { x: number; y: number; rx: number; ry: number };
  plotOrigin: { x: number; y: number };
  rows: number;
  cols: number;
  plotW: number;
  plotH: number;
  alleyX: number;
  alleyY: number;
  /** 每小区基础植被反射率参数 (row,col) -> 5 波段 */
  genotypeSignatures: Float32Array;
}

/** 典型植被/土壤端元反射率 (B,G,R,RE,NIR) */
const VEG_BASE = [0.045, 0.09, 0.055, 0.22, 0.48];
const SOIL_BASE = [0.14, 0.17, 0.2, 0.23, 0.26];
const ALLEY_BASE = [0.1, 0.12, 0.14, 0.16, 0.18];

export function generateSyntheticScene(params: SyntheticSceneParams = {}): SyntheticScene {
  const width = params.width ?? 2048;
  const height = params.height ?? 2048;
  const tileSize = params.tileSize ?? 256;
  const rows = params.rows ?? 16;
  const cols = params.cols ?? 20;
  const plotW = params.plotW ?? 72;
  const plotH = params.plotH ?? 48;
  const alleyX = params.alleyX ?? 14;
  const alleyY = params.alleyY ?? 10;
  const originX = params.originX ?? 40;
  const originY = params.originY ?? 40;
  const seed = params.seed ?? 42;
  const growth = params.growthStage ?? 0.6;
  const rand = mulberry32(seed);

  // 每个小区一个品系签名: 在植被端元上做随机扰动
  const signatures = new Float32Array(rows * cols * BAND_COUNT);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const vigor = 0.7 + rand() * 0.6; // 品系长势差异
      const stress = rand() * 0.08; // 胁迫差异(压低 NIR/RE)
      for (let b = 0; b < BAND_COUNT; b++) {
        const isNirLike = b >= 3;
        const base = VEG_BASE[b] * (0.75 + growth * 0.45) * vigor;
        signatures[(r * cols + c) * BAND_COUNT + b] = isNirLike ? base - stress : base + stress * 0.3;
      }
    }
  }

  // 定标板: 右下角 4 档灰阶
  const panelW = 96;
  const panelH = 24;
  const panelRect = { x: width - panelW - 60, y: height - panelH - 60, w: panelW, h: panelH };
  const panelLevels = [0.08, 0.24, 0.48, 0.72];

  // 云和阴影 (椭圆, 软边)
  const cloud = { x: width * 0.68, y: height * 0.3, rx: width * 0.13, ry: height * 0.09 };
  const shadow = { x: width * 0.3, y: height * 0.62, rx: width * 0.16, ry: height * 0.1 };

  const data = new Uint16Array(width * height * BAND_COUNT);
  const pixel = new Float32Array(BAND_COUNT);
  // 辐射响应: DN = refl / gainBase + 暗电流; 每波段略有差异
  // 保证 refl=1 时 DN < 65535, 全反射率范围不饱和
  const gainBase = [2.0e-5, 1.85e-5, 2.2e-5, 1.7e-5, 1.55e-5];
  const darkOffset = 300;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const off = (y * width + x) * BAND_COUNT;
      // 判定所在小区
      const lx = x - originX;
      const ly = y - originY;
      const cellW = plotW + alleyX;
      const cellH = plotH + alleyY;
      const c = Math.floor(lx / cellW);
      const r = Math.floor(ly / cellH);
      const inPlotX = lx - c * cellW;
      const inPlotY = ly - r * cellH;
      let endmember: number[];
      if (r >= 0 && r < rows && c >= 0 && c < cols && inPlotX < plotW && inPlotY < plotH) {
        const sigOff = (r * cols + c) * BAND_COUNT;
        // 行播纹理: 每 6 像素一行作物, 行间露出土壤
        const rowPhase = inPlotY % 6;
        const inCropRow = rowPhase < 4;
        // 株间噪声纹理
        const canopyNoise = 0.92 + 0.16 * pseudoNoise(x, y, seed);
        for (let b = 0; b < BAND_COUNT; b++) {
          const veg = signatures[sigOff + b] * canopyNoise;
          pixel[b] = inCropRow ? veg : SOIL_BASE[b] * (0.9 + 0.2 * pseudoNoise(x + 7, y, seed));
        }
        endmember = VEG_BASE;
      } else {
        // 走道/田埂
        for (let b = 0; b < BAND_COUNT; b++) {
          pixel[b] = ALLEY_BASE[b] * (0.85 + 0.3 * pseudoNoise(x, y + 3, seed));
        }
        endmember = ALLEY_BASE;
      }

      // 定标板覆盖
      if (
        x >= panelRect.x &&
        x < panelRect.x + panelRect.w &&
        y >= panelRect.y &&
        y < panelRect.y + panelRect.h
      ) {
        const levelIdx = Math.min(3, Math.floor(((x - panelRect.x) / panelRect.w) * 4));
        const refl = panelLevels[levelIdx];
        for (let b = 0; b < BAND_COUNT; b++) pixel[b] = refl;
      }

      // 云 (软椭圆, 抬升全波段反射率)
      const ec = Math.pow((x - cloud.x) / cloud.rx, 2) + Math.pow((y - cloud.y) / cloud.ry, 2);
      if (ec < 1) {
        const strength = 0.85 * (1 - ec * ec);
        for (let b = 0; b < BAND_COUNT; b++) pixel[b] = pixel[b] * (1 - strength) + 0.7 * strength;
      }
      // 阴影 (压暗全波段, 保持光谱形状)
      const es = Math.pow((x - shadow.x) / shadow.rx, 2) + Math.pow((y - shadow.y) / shadow.ry, 2);
      if (es < 1) {
        const strength = 0.82 * (1 - es * es);
        for (let b = 0; b < BAND_COUNT; b++) pixel[b] *= 1 - strength;
      }

      // DN 转换 + 泊松风格噪声
      for (let b = 0; b < BAND_COUNT; b++) {
        const refl = Math.max(0, Math.min(1, pixel[b]));
        const dn = darkOffset + refl / gainBase[b] + (rand() - 0.5) * 26;
        data[off + b] = clampUint16(dn);
      }
      void endmember;
    }
  }

  return {
    data,
    width,
    height,
    tileSize,
    bands: BAND_COUNT,
    panelRect,
    panelLevels,
    cloud,
    shadow,
    plotOrigin: { x: originX, y: originY },
    rows,
    cols,
    plotW,
    plotH,
    alleyX,
    alleyY,
    genotypeSignatures: signatures,
  };
}

/** 确定性二维值噪声, 比纯随机更像真实冠层纹理 */
function pseudoNoise(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = h ^ (h >>> 16);
  return ((h >>> 0) % 10000) / 10000;
}

export function sceneToTiff(scene: SyntheticScene): ArrayBuffer {
  return writeTiledTiff({
    width: scene.width,
    height: scene.height,
    tileSize: scene.tileSize,
    bands: scene.bands,
    bandNames: ['B', 'G', 'R', 'RE', 'NIR'],
    data: scene.data,
  });
}

export function makeFlightMeta(scene: SyntheticScene, date: string, name: string, gsd = 0.05): Omit<FlightImage, 'id' | 'experimentId' | 'importedAt' | 'levels'> {
  return {
    date,
    name,
    width: scene.width,
    height: scene.height,
    tileSize: scene.tileSize,
    dtype: 'uint16',
    bands: ['B', 'G', 'R', 'RE', 'NIR'],
    gsd,
  };
}
