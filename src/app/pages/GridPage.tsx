import { useEffect, useMemo, useState } from 'react';
import { useAppStore, DEFAULT_GRID } from '../../state/store';
import { listDesigns, loadGrid, saveDesigns, saveGrid } from '../../db/idb';
import { buildPlotGrid } from '../../core/geometry';
import { parseCsv, toCsv, downloadText } from '../../core/util';
import { toast } from '../components/Toast';
import type { DesignRow, Plot, PlotGridConfig } from '../../types';

export function GridPage() {
  const store = useAppStore();
  const [cfg, setCfg] = useState<PlotGridConfig>(DEFAULT_GRID);
  const [selectedRow, setSelectedRow] = useState<number | null>(null);
  const [selectedCol, setSelectedCol] = useState<number | null>(null);
  const [designs, setDesigns] = useState<DesignRow[]>([]);

  useEffect(() => {
    if (!store.currentExperimentId) return;
    void loadGrid(store.currentExperimentId).then((g) => {
      if (g) {
        setCfg(g.config);
        store.setGrid(g.config, g.plots);
      }
    });
    void listDesigns(store.currentExperimentId).then(setDesigns);
  }, [store.currentExperimentId]);

  const plots = useMemo(() => buildPlotGrid(cfg), [cfg]);
  const designMap = useMemo(() => {
    const m = new Map<string, DesignRow>();
    for (const d of designs) m.set(`${d.row}/${d.col}`, d);
    return m;
  }, [designs]);

  const update = (patch: Partial<PlotGridConfig>) => setCfg((c) => ({ ...c, ...patch }));

  const persist = async () => {
    if (!store.currentExperimentId) {
      toast('请先选择试验');
      return;
    }
    const finalPlots = plots.map((p) => {
      const d = designMap.get(`${p.row}/${p.col}`);
      return d ? { ...p, genotype: d.genotype, replicate: d.replicate, isCheck: d.isCheck } : p;
    });
    await saveGrid(store.currentExperimentId, cfg, finalPlots);
    store.setGrid(cfg, finalPlots);
    toast(`已保存 ${finalPlots.length} 个小区`, 'info');
  };

  const nudge = (delta: number) => {
    if (selectedRow !== null) {
      update({ rowOffsets: { ...cfg.rowOffsets, [selectedRow]: (cfg.rowOffsets[selectedRow] ?? 0) + delta } });
    } else if (selectedCol !== null) {
      update({ colOffsets: { ...cfg.colOffsets, [selectedCol]: (cfg.colOffsets[selectedCol] ?? 0) + delta } });
    }
  };

  const onCsv = async (file: File) => {
    const text = await file.text();
    const rows = parseCsv(text);
    const header = rows[0].map((h) => h.trim().toLowerCase());
    const ri = header.indexOf('row');
    const ci = header.indexOf('col');
    const gi = header.findIndex((h) => h.includes('genotype') || h.includes('品系') || h.includes('品种'));
    const repI = header.findIndex((h) => h.includes('rep') || h.includes('重复'));
    const ckI = header.findIndex((h) => h.includes('check') || h.includes('对照'));
    if (ri < 0 || ci < 0 || gi < 0) {
      toast('CSV 需包含 row, col, genotype 列 (可选 replicate, isCheck)');
      return;
    }
    const out: DesignRow[] = rows.slice(1).filter((r) => r.length >= 3).map((r) => ({
      experimentId: store.currentExperimentId!,
      row: Number(r[ri]) - 1,
      col: Number(r[ci]) - 1,
      genotype: r[gi],
      replicate: repI >= 0 ? Number(r[repI]) : 1,
      isCheck: ckI >= 0 ? /^(1|true|yes|是|对照)$/i.test(r[ckI].trim()) : r[gi].startsWith('CK'),
    }));
    await saveDesigns(out);
    setDesigns(out);
    toast(`导入设计表 ${out.length} 行`, 'info');
  };

  const exportTemplate = () => {
    downloadText(
      'design_template.csv',
      toCsv([
        ['row', 'col', 'genotype', 'replicate', 'isCheck'],
        ['1', '1', 'G001', '1', '0'],
        ['1', '2', 'CK1', '1', '1'],
      ]),
    );
  };

  const checkCount = designs.filter((d) => d.isCheck).length;

  return (
    <div className="page">
      <h2 className="page-title">小区网格</h2>
      <p className="page-sub">按田间种植图生成小区网格, 支持整体旋转对齐播种方向、单行单列微调偏移和田间设计表导入。</p>

      <div className="grid cols-2">
        <div className="card">
          <h3>网格参数</h3>
          <div className="grid cols-2">
            <NumField label="行数" value={cfg.rows} onChange={(v) => update({ rows: v })} />
            <NumField label="列数" value={cfg.cols} onChange={(v) => update({ cols: v })} />
            <NumField label="小区宽 (px)" value={cfg.plotW} onChange={(v) => update({ plotW: v })} />
            <NumField label="小区高 (px)" value={cfg.plotH} onChange={(v) => update({ plotH: v })} />
            <NumField label="列间走道宽 (px)" value={cfg.alleyX} onChange={(v) => update({ alleyX: v })} />
            <NumField label="行间走道宽 (px)" value={cfg.alleyY} onChange={(v) => update({ alleyY: v })} />
            <NumField label="原点 X (px)" value={cfg.originX} onChange={(v) => update({ originX: v })} />
            <NumField label="原点 Y (px)" value={cfg.originY} onChange={(v) => update({ originY: v })} />
            <NumField label="旋转角 (度)" value={cfg.angleDeg} step={0.5} onChange={(v) => update({ angleDeg: v })} />
            <NumField label="四周内缩 (px)" value={cfg.insetPx} onChange={(v) => update({ insetPx: v })} />
          </div>
          <div className="row" style={{ marginTop: 14 }}>
            <button className="primary" onClick={() => void persist()}>保存网格 ({plots.length} 小区)</button>
            <button onClick={() => setCfg(DEFAULT_GRID)}>重置默认</button>
          </div>
        </div>

        <div className="card">
          <h3>单行/单列微调</h3>
          <div className="row">
            <select value={selectedRow ?? ''} onChange={(e) => { setSelectedRow(e.target.value === '' ? null : Number(e.target.value)); setSelectedCol(null); }}>
              <option value="">选择行…</option>
              {Array.from({ length: cfg.rows }, (_, i) => <option key={i} value={i}>第 {i + 1} 行 (偏移 {cfg.rowOffsets[i] ?? 0})</option>)}
            </select>
            <select value={selectedCol ?? ''} onChange={(e) => { setSelectedCol(e.target.value === '' ? null : Number(e.target.value)); setSelectedRow(null); }}>
              <option value="">选择列…</option>
              {Array.from({ length: cfg.cols }, (_, i) => <option key={i} value={i}>第 {i + 1} 列 (偏移 {cfg.colOffsets[i] ?? 0})</option>)}
            </select>
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <button onClick={() => nudge(-4)}>-4 px</button>
            <button onClick={() => nudge(-1)}>-1 px</button>
            <button onClick={() => nudge(1)}>+1 px</button>
            <button onClick={() => nudge(4)}>+4 px</button>
            <button
              onClick={() => {
                if (selectedRow !== null) update({ rowOffsets: Object.fromEntries(Object.entries(cfg.rowOffsets).filter(([k]) => Number(k) !== selectedRow)) });
                if (selectedCol !== null) update({ colOffsets: Object.fromEntries(Object.entries(cfg.colOffsets).filter(([k]) => Number(k) !== selectedCol)) });
              }}
            >
              清除微调
            </button>
          </div>

          <h3 style={{ marginTop: 20 }}>田间设计表 (RCBD)</h3>
          <div className="muted">已载入 {designs.length} 行, 其中对照 {checkCount} 个</div>
          <div className="row" style={{ marginTop: 8 }}>
            <CsvInput onFile={(f) => void onCsv(f)} />
            <button onClick={exportTemplate}>下载 CSV 模板</button>
          </div>
        </div>
      </div>

      <div className="card">
        <h3>网格预览 (前 100 个小区)</h3>
        <GridPreview plots={plots} designMap={designMap} />
      </div>
    </div>
  );
}

function NumField({ label, value, onChange, step = 1 }: { label: string; value: number; onChange: (v: number) => void; step?: number }) {
  return (
    <div>
      <label>{label}</label>
      <input type="number" step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </div>
  );
}

function CsvInput({ onFile }: { onFile: (f: File) => void }) {
  return (
    <>
      <input type="file" accept=".csv" id="csv-input" hidden onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
      <button onClick={() => document.getElementById('csv-input')?.click()}>导入设计表 CSV</button>
    </>
  );
}

function GridPreview({ plots, designMap }: { plots: Plot[]; designMap: Map<string, DesignRow> }) {
  const W = 760;
  const H = 320;
  const xs = plots.map((p) => p.cx);
  const ys = plots.map((p) => p.cy);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const sx = W / (maxX - minX + 120);
  const sy = H / (maxY - minY + 80);
  const scale = Math.min(sx, sy);
  return (
    <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`}>
      {plots.slice(0, 100).map((p) => {
        const d = designMap.get(`${p.row}/${p.col}`);
        const color = d?.isCheck ? '#ffd34d' : d ? '#4da3ff' : '#5c7186';
        const x = W / 2 + (p.cx - (minX + maxX) / 2) * scale - (p.w * scale) / 2;
        const y = H / 2 + (p.cy - (minY + maxY) / 2) * scale - (p.h * scale) / 2;
        return (
          <g key={p.id} transform={`rotate(${(p.angleRad * 180) / Math.PI} ${x + (p.w * scale) / 2} ${y + (p.h * scale) / 2})`}>
            <rect x={x} y={y} width={p.w * scale} height={p.h * scale} fill="none" stroke={color} strokeWidth={1.2} />
          </g>
        );
      })}
    </svg>
  );
}
