import type { Calibration, CalibrationPanelFit, DesignRow, PlotGridConfig } from '../../types';
import { BAND_COUNT } from '../../types';
import { generateSyntheticScene, type SyntheticScene } from '../../io/synthetic';
import { importPlanarRaster } from '../../io/importer';
import {
  putCalibration,
  putExperiment,
  saveDesigns,
  saveGrid,
  getImage,
  putImage,
} from '../../db/idb';
import { fitCalibration, validateCalibration } from '../../core/calibration';
import { buildPlotGrid } from '../../core/geometry';
import { uid } from '../../core/util';
import { DEFAULT_GRID } from '../../state/store';

/**
 * 生成完整演示数据集:
 *  - 1 个试验, 16x20 小区
 *  - 3 个飞行日期 (不同生育期), 每期含定标板/云影/行播纹理/走道
 *  - 每期一组辐射定标系数 (由定标板 DN 与已知反射率拟合)
 *  - RCBD 田间设计表 (4 个对照品种 + 品系编号 + 重复号)
 */
export async function generateDemoDataset(
  onProgress: (stage: string, pct: number) => void,
): Promise<string> {
  const experimentId = uid('exp');
  await putExperiment({
    id: experimentId,
    name: '演示: 小麦品系比较 RCBD',
    crop: '小麦',
    season: '2026 春季',
    design: 'RCBD',
    notes: '系统生成的合成五波段数据集',
    createdAt: Date.now(),
  });

  const dates = [
    { date: '2026-03-18', growth: 0.25, name: '返青期' },
    { date: '2026-04-22', growth: 0.65, name: '拔节-抽穗期' },
    { date: '2026-05-20', growth: 0.9, name: '灌浆期' },
  ];

  const scenes: SyntheticScene[] = [];
  for (let i = 0; i < dates.length; i++) {
    onProgress(`生成合成影像 ${i + 1}/3: ${dates[i].name}`, 0.05 + i * 0.25);
    // 每期影像有轻微位移, 模拟飞行配准偏差
    const scene = generateSyntheticScene({
      width: 2048,
      height: 2048,
      tileSize: 256,
      rows: 16,
      cols: 20,
      seed: 42 + i,
      growthStage: dates[i].growth,
    });
    scenes.push(scene);
    const imported = await importPlanarRaster(
      scene.data,
      scene.width,
      scene.height,
      experimentId,
      dates[i].date,
      `合成影像 ${dates[i].date} ${dates[i].name}`,
      0.05,
      256,
      (stage, pct) => onProgress(`${dates[i].date} ${stage}`, 0.1 + i * 0.28 + pct * 0.22),
    );

    // 从定标板 ROI 读取 DN 均值并拟合定标
    onProgress(`拟合辐射定标 ${dates[i].date}`, 0.32 + i * 0.22);
    const panels = extractPanels(scene);
    const fit = fitCalibration(panels);
    const err = validateCalibration(fit.r2, 0.85);
    if (err) throw new Error(err);
    const calibration: Calibration = {
      id: uid('cal'),
      experimentId,
      imageId: imported.image.id,
      date: dates[i].date,
      gains: fit.gains,
      offsets: fit.offsets,
      r2: fit.r2,
      panels,
      createdAt: Date.now(),
    };
    await putCalibration(calibration);
    const img = await getImage(imported.image.id);
    if (img) {
      await putImage({ ...img, calibrationId: calibration.id });
    }
  }

  // 小区网格 (与合成场景参数一致)
  const cfg: PlotGridConfig = {
    ...DEFAULT_GRID,
    rows: 16,
    cols: 20,
    plotW: scenes[0].plotW,
    plotH: scenes[0].plotH,
    alleyX: scenes[0].alleyX,
    alleyY: scenes[0].alleyY,
    originX: scenes[0].plotOrigin.x,
    originY: scenes[0].plotOrigin.y,
  };
  const plots = buildPlotGrid(cfg);
  await saveGrid(experimentId, cfg, plots);

  // RCBD 设计: 320 小区, 4 重复, 每重复 80 品系, 其中 4 个对照
  onProgress('生成 RCBD 田间设计表', 0.95);
  const designs: DesignRow[] = [];
  const checks = new Set(['CK1', 'CK2', 'CK3', 'CK4']);
  const repBlocks = 4;
  for (const plot of plots) {
    const replicate = (plot.row % repBlocks) + 1;
    const isCheck = plot.col % 17 === 0;
    const genotype = isCheck
      ? `CK${(plot.col % 4) + 1}`
      : `G${String(((plot.row * 20 + plot.col) % 76) + 1).padStart(3, '0')}`;
    designs.push({ experimentId, row: plot.row, col: plot.col, genotype, replicate, isCheck });
    void checks;
  }
  await saveDesigns(designs);
  onProgress('完成', 1);
  return experimentId;
}

/** 从合成场景的定标板区域提取每档 DN 均值 */
function extractPanels(scene: SyntheticScene): CalibrationPanelFit[] {
  const { panelRect, panelLevels } = scene;
  const segW = panelRect.w / panelLevels.length;
  const panels: CalibrationPanelFit[] = [];
  for (let i = 0; i < panelLevels.length; i++) {
    const x0 = Math.floor(panelRect.x + i * segW) + 2;
    const x1 = Math.floor(panelRect.x + (i + 1) * segW) - 2;
    const y0 = panelRect.y + 2;
    const y1 = panelRect.y + panelRect.h - 2;
    const sums = new Float64Array(BAND_COUNT);
    let n = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        for (let b = 0; b < BAND_COUNT; b++) sums[b] += scene.data[(y * scene.width + x) * BAND_COUNT + b];
        n++;
      }
    }
    panels.push({
      rect: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 },
      reflectance: new Array(BAND_COUNT).fill(panelLevels[i]),
      meanDN: Array.from(sums, (s) => s / n),
    });
  }
  return panels;
}
