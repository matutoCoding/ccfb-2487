import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../../state/store';
import {
  getCalibrationByImage,
  listImages,
  putCalibration,
  putImage,
} from '../../db/idb';
import { importGeoTiff } from '../../io/importer';
import { buildLut } from '../../core/colormap';
import { compileExpression, ExpressionError } from '../../core/expression';
import { fitCalibration, validateCalibration } from '../../core/calibration';
import { uid, formatBytes, toCsv, downloadText } from '../../core/util';
import { toast } from '../components/Toast';
import { useGpu, useRasterService } from '../services/gpu-hooks';
import { RasterCanvas } from '../viewer/RasterCanvas';
import { OverlayCanvas } from '../viewer/OverlayCanvas';
import { fitCamera, screenToWorld } from '../viewer/camera';
import { useCameraInteraction } from '../viewer/useCameraInteraction';
import type { Calibration, CalibrationPanelInput, FlightImage } from '../../types';

export function ImagesPage() {
  const store = useAppStore();
  const { caps, error: gpuError } = useGpu();
  const [images, setImages] = useState<FlightImage[]>([]);
  const [image, setImage] = useState<FlightImage | null>(null);
  const [calibration, setCalibration] = useState<Calibration | null>(null);
  const [showMask, setShowMask] = useState(true);
  const [stretch, setStretch] = useState<[number, number]>([0, 1]);
  const [exprText, setExprText] = useState('(NIR - R) / (NIR + R)');
  const [exprError, setExprError] = useState<string | null>(null);
  const [drawingPanel, setDrawingPanel] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [panelInputs, setPanelInputs] = useState<CalibrationPanelInput[]>([]);
  const wrapRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const expr = useMemo(() => {
    try {
      const compiled = compileExpression(exprText);
      setExprError(null);
      return compiled;
    } catch (e) {
      setExprError(e instanceof ExpressionError ? `${e.message} (位置 ${e.pos})` : String(e));
      return null;
    }
  }, [exprText]);

  const service = useRasterService(image);
  const initialCam = useMemo(() => (image ? fitCamera(image, 1200, 900) : fitCamera({ width: 1, height: 1 } as FlightImage, 1200, 900)), [image?.id]);
  const { camera, setCamera } = useCameraInteraction(initialCam, wrapRef);
  const lut = useMemo(() => buildLut(store.settings.colormap), [store.settings.colormap]);

  const refreshImages = async () => {
    if (!store.currentExperimentId) {
      setImages([]);
      return;
    }
    const rows = await listImages(store.currentExperimentId);
    setImages(rows);
    if (rows.length > 0 && (!image || !rows.some((r) => r.id === image.id))) {
      await selectImage(rows[0]);
    }
  };
  useEffect(() => {
    void refreshImages();
  }, [store.currentExperimentId]);

  const selectImage = async (img: FlightImage) => {
    setImage(img);
    store.setCurrentImage(img.id);
    const cal = await getCalibrationByImage(img.id);
    setCalibration(cal ?? null);
    setPanelInputs(cal?.panels ?? []);
    setStretch([store.settings.histogramLowPct / 100, store.settings.histogramHighPct / 100]);
  };

  // 切换指数/影像后按直方图百分比重新拉伸
  useEffect(() => {
    if (!service || !calibration || !expr) return;
    let cancelled = false;
    void service.getStretch(expr, calibration, store.settings.histogramLowPct, store.settings.histogramHighPct).then(([lo, hi]) => {
      if (!cancelled) setStretch([lo, hi]);
    });
    return () => {
      cancelled = true;
    };
  }, [service, calibration, expr, store.settings.histogramLowPct, store.settings.histogramHighPct]);

  const onImportFile = async (file: File) => {
    if (!store.currentExperimentId) {
      toast('请先在试验列表选择或创建试验');
      return;
    }
    store.setBusy(true, '读取文件…', 0.02);
    try {
      const buf = await file.arrayBuffer();
      const date = new Date().toISOString().slice(0, 10);
      const result = await importGeoTiff(buf, store.currentExperimentId, date, file.name, 0.05, {
        tileSize: store.settings.tileSize,
        onProgress: (stage, pct) => store.setBusy(true, stage, pct),
      });
      toast(`导入完成: ${result.tileCount} 个切片, ${formatBytes(result.bytes)}`, 'info');
      await refreshImages();
      await selectImage(result.image);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      store.setBusy(false);
    }
  };

  const onWrapPointerDown = (e: React.PointerEvent) => {
    if (!drawingPanel || e.button !== 0) return;
    const rect = wrapRef.current!.getBoundingClientRect();
    setDrawingPanel({ ...drawingPanel, x1: e.clientX - rect.left, y1: e.clientY - rect.top });
  };

  const startPanel = () => {
    const rect = wrapRef.current!.getBoundingClientRect();
    setDrawingPanel({ x0: rect.width / 2 - 40, y0: rect.height / 2 - 12, x1: rect.width / 2 + 40, y1: rect.height / 2 + 12 });
    toast('在影像上拖出定标板 ROI, 然后填写该板反射率', 'info');
  };

  const confirmPanel = () => {
    if (!drawingPanel || !image) return;
    const rect = wrapRef.current!.getBoundingClientRect();
    const [wx0, wy0] = screenToWorld(camera, rect.width, rect.height, drawingPanel.x0, drawingPanel.y0);
    const [wx1, wy1] = screenToWorld(camera, rect.width, rect.height, drawingPanel.x1, drawingPanel.y1);
    const reflStr = prompt('该定标板五波段反射率 (逗号分隔, 如 0.48,0.48,0.48,0.48,0.48):', '0.48,0.48,0.48,0.48,0.48');
    if (!reflStr) return;
    const reflectance = reflStr.split(',').map(Number);
    if (reflectance.length !== 5 || reflectance.some((v) => !Number.isFinite(v))) {
      toast('反射率需要 5 个数值');
      return;
    }
    setPanelInputs((prev) => [
      ...prev,
      { rect: { x: Math.min(wx0, wx1), y: Math.min(wy0, wy1), w: Math.abs(wx1 - wx0), h: Math.abs(wy1 - wy0) }, reflectance },
    ]);
    setDrawingPanel(null);
  };

  const runCalibration = async () => {
    if (!image || panelInputs.length === 0) {
      toast('至少需要一块定标板 ROI');
      return;
    }
    store.setBusy(true, '读取定标板 DN 并拟合…', 0.3);
    try {
      // 从 level0 切片读取 ROI 均值
      const fits = await Promise.all(panelInputs.map((p) => measurePanel(service!, image, p)));
      const fit = fitCalibration(fits);
      const err = validateCalibration(fit.r2);
      if (err) throw new Error(err);
      const cal: Calibration = {
        id: calibration?.id ?? uid('cal'),
        experimentId: image.experimentId,
        imageId: image.id,
        date: image.date,
        gains: fit.gains,
        offsets: fit.offsets,
        r2: fit.r2,
        panels: fits,
        createdAt: Date.now(),
      };
      await putCalibration(cal);
      const updated = { ...image, calibrationId: cal.id };
      await putImage(updated);
      setImage(updated);
      setCalibration(cal);
      toast(`定标完成, 各波段 R²=${fit.r2.map((v) => v.toFixed(4)).join(', ')}`, 'info');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      store.setBusy(false);
    }
  };

  const exportCalibrationCsv = () => {
    if (!calibration) return;
    const rows: (string | number)[][] = [
      ['波段', 'gain', 'offset', 'R2'],
      ...['B', 'G', 'R', 'RE', 'NIR'].map((b, i) => [b, calibration.gains[i], calibration.offsets[i], calibration.r2[i]]),
    ];
    downloadText(`calibration_${image?.date}.csv`, toCsv(rows));
  };

  const plots = store.plots;
  const checkPlots = useMemo(() => new Set(plots.filter((p) => p.isCheck).map((p) => p.id)), [plots]);

  return (
    <div className="page" style={{ padding: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {!store.currentExperimentId ? (
        <div className="page"><div className="card">请先在「试验列表」选择一个试验。</div></div>
      ) : (
        <div className="viewer-layout">
          <div className="viewer-side">
            <h3>飞行影像 ({images.length})</h3>
            <div className="pill-btns" style={{ flexDirection: 'column' }}>
              {images.map((img) => (
                <button
                  key={img.id}
                  className={image?.id === img.id ? 'active' : ''}
                  style={{ textAlign: 'left' }}
                  onClick={() => void selectImage(img)}
                >
                  {img.date} {img.name.slice(0, 12)}
                  <span className={`tag ${img.calibrationId ? 'ok' : 'warn'}`} style={{ marginLeft: 6 }}>
                    {img.calibrationId ? '已定标' : '未定标'}
                  </span>
                </button>
              ))}
              {images.length === 0 && <div className="muted">暂无影像</div>}
            </div>

            <div style={{ marginTop: 14 }}>
              <input ref={fileRef} type="file" accept=".tif,.tiff" hidden onChange={(e) => e.target.files?.[0] && void onImportFile(e.target.files[0])} />
              <button onClick={() => fileRef.current?.click()}>导入五波段 GeoTIFF</button>
            </div>

            <div className="card" style={{ marginTop: 14 }}>
              <h3>辐射定标</h3>
              {calibration ? (
                <div className="muted" style={{ lineHeight: 1.8 }}>
                  已定标 ✓<br />
                  R²: {calibration.r2.map((v) => v.toFixed(3)).join(', ')}
                </div>
              ) : (
                <div className="tag danger" style={{ marginBottom: 8 }}>未定标 — 指数计算与统计将被阻止</div>
              )}
              <div className="row" style={{ marginTop: 8 }}>
                <button onClick={startPanel}>框选定标板 ROI</button>
                <button onClick={confirmPanel} disabled={!drawingPanel}>确认 ROI</button>
                <button className="primary" disabled={panelInputs.length === 0} onClick={() => void runCalibration()}>
                  拟合定标 ({panelInputs.length})
                </button>
              </div>
              {calibration && <button style={{ marginTop: 8 }} onClick={exportCalibrationCsv}>导出定标系数 CSV</button>}
            </div>

            <div className="card">
              <h3>波段运算表达式</h3>
              <textarea rows={3} value={exprText} onChange={(e) => setExprText(e.target.value)} />
              {exprError ? (
                <div className="tag danger" style={{ marginTop: 6 }}>{exprError}</div>
              ) : (
                <div className="tag ok" style={{ marginTop: 6 }}>编译通过 → 已实时生成 WGSL 着色器</div>
              )}
              <div className="pill-btns" style={{ marginTop: 8 }}>
                {store.expressions.map((e) => (
                  <button key={e.name} className={e.expr === exprText ? 'active' : ''} onClick={() => setExprText(e.expr)}>
                    {e.name}
                  </button>
                ))}
              </div>
              <div className="muted" style={{ marginTop: 8 }}>
                拉伸区间 [{stretch[0].toFixed(3)}, {stretch[1].toFixed(3)}] (直方图 {store.settings.histogramLowPct}%-{store.settings.histogramHighPct}%)
              </div>
              <label className="row" style={{ marginTop: 8 }}>
                <input type="checkbox" style={{ width: 'auto' }} checked={showMask} onChange={(e) => setShowMask(e.target.checked)} />
                显示云/阴影/土壤掩膜
              </label>
            </div>
            {gpuError && <div className="tag danger">{gpuError}</div>}
          </div>

          <div className="viewer-canvas-wrap" ref={wrapRef} onPointerDown={onWrapPointerDown}>
            {caps && image && calibration && expr ? (
              <>
                <RasterCanvas
                  caps={caps}
                  image={image}
                  camera={camera}
                  expr={expr}
                  calibration={calibration}
                  mask={store.settings.mask}
                  showMask={showMask}
                  stretch={stretch}
                  lutRgba={lut}
                  acquireTexture={(l, ty, tx) => service!.acquireTexture(l, ty, tx)}
                />
                <OverlayCanvas
                  imageWidth={image.width}
                  imageHeight={image.height}
                  camera={camera}
                  plots={plots}
                  checkPlots={checkPlots}
                  gcps={[]}
                  showPlots={plots.length > 0}
                />
              </>
            ) : (
              <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: 'var(--fg-dim)' }}>
                {!image ? '该试验还没有影像' : !calibration ? '请先完成辐射定标, 之后才能计算反射率与指数' : 'WebGPU 初始化中…'}
              </div>
            )}
            {drawingPanel && (
              <div
                style={{
                  position: 'absolute',
                  left: drawingPanel.x0,
                  top: drawingPanel.y0,
                  width: drawingPanel.x1 - drawingPanel.x0,
                  height: drawingPanel.y1 - drawingPanel.y0,
                  border: '2px dashed #ff6b6b',
                  pointerEvents: 'none',
                }}
              />
            )}
            <div className="muted" style={{ position: 'absolute', left: 12, bottom: 10, background: 'rgba(0,0,0,0.45)', padding: '4px 10px', borderRadius: 6 }}>
              缩放 {camera.scale.toFixed(3)} px/px · 中心 ({camera.centerX.toFixed(0)}, {camera.centerY.toFixed(0)})
              <button style={{ marginLeft: 10, padding: '2px 8px' }} onClick={() => image && setCamera(fitCamera(image, wrapRef.current?.clientWidth ?? 1200, wrapRef.current?.clientHeight ?? 900))}>
                适配窗口
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** 从 IDB 切片读取定标板 ROI 内五波段 DN 均值 */
async function measurePanel(service: NonNullable<ReturnType<typeof useRasterService>>, image: FlightImage, input: CalibrationPanelInput) {
  const ts = image.tileSize;
  const { x, y, w, h } = input.rect;
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(image.width, Math.ceil(x + w));
  const y1 = Math.min(image.height, Math.ceil(y + h));
  const sums = new Float64Array(5);
  let count = 0;
  const tileCache = new Map<string, Uint16Array>();
  for (let py = y0; py < y1; py++) {
    for (let px = x0; px < x1; px++) {
      const tx = Math.floor(px / ts);
      const ty = Math.floor(py / ts);
      const key = `${ty}/${tx}`;
      let tile = tileCache.get(key);
      if (!tile) {
        tile = await service.fetchTile(0, ty, tx);
        tileCache.set(key, tile);
      }
      const t: Uint16Array = tile;
      const lx = px - tx * ts;
      const ly = py - ty * ts;
      for (let b = 0; b < 5; b++) sums[b] += t[(ly * ts + lx) * 5 + b];
      count++;
    }
  }
  return { rect: input.rect, reflectance: input.reflectance, meanDN: Array.from(sums, (s) => s / count) };
}
