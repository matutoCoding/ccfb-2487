import { useEffect, useState } from 'react';
import { useAppStore } from '../../state/store';
import { getCalibrationByImage, getStats, listDesigns, listImages, putStatsBatch } from '../../db/idb';
import { useGpu, useRasterService, useStatsRunner } from '../services/gpu-hooks';
import { compileExpression } from '../../core/expression';
import { computePlotStatsCpu, oneWayAnova, type AnovaResult } from '../../core/stats';
import { toCsv, downloadText, formatMs } from '../../core/util';
import { toast } from '../components/Toast';
import type { FlightImage, Plot, PlotStats } from '../../types';

export function StatsPage() {
  const store = useAppStore();
  const { caps } = useGpu();
  const [images, setImages] = useState<FlightImage[]>([]);
  const [image, setImage] = useState<FlightImage | null>(null);
  const [stats, setStats] = useState<PlotStats[]>([]);
  const [ms, setMs] = useState(0);
  const [verify, setVerify] = useState<{ maxRelErrMean: number; maxRelErrMedian: number; checked: number; msCpu: number } | null>(null);
  const [anova, setAnova] = useState<AnovaResult | null>(null);
  const service = useRasterService(image);
  const { run } = useStatsRunner(service);
  const exprName = store.currentExprName;
  const exprDef = store.expressions.find((e) => e.name === exprName) ?? store.expressions[0];

  useEffect(() => {
    if (!store.currentExperimentId) return;
    void listImages(store.currentExperimentId).then((rows) => {
      setImages(rows);
      if (rows[0] && !image) setImage(rows[0]);
    });
  }, [store.currentExperimentId]);

  useEffect(() => {
    if (!image) {
      setStats([]);
      return;
    }
    void getStats(image.id, exprDef.name).then((rows) => setStats(rows));
  }, [image, exprDef.name]);

  const plots = store.plots;
  const [designRows, setDesignRows] = useState<Awaited<ReturnType<typeof listDesigns>>>([]);
  useEffect(() => {
    if (!store.currentExperimentId) {
      setDesignRows([]);
      return;
    }
    void listDesigns(store.currentExperimentId).then(setDesignRows);
  }, [store.currentExperimentId, plots.length]);

  const runGpu = async () => {
    if (!image || !service || plots.length === 0) {
      toast('请先在「小区网格」保存网格');
      return;
    }
    const cal = await getCalibrationByImage(image.id);
    if (!cal) {
      toast('该影像未辐射定标, 不允许计算 (定标门控)');
      return;
    }
    const expr = compileExpression(exprDef.expr);
    const t0 = performance.now();
    const result = await run(plots, cal, expr, exprDef.name);
    setMs(performance.now() - t0);
    if (!result) return;
    setStats(result);
    await putStatsBatch(result);
    toast(`GPU 一趟完成 ${result.length} 个小区, 用时 ${formatMs(ms || performance.now() - t0)}`, 'info');
  };

  const runCpuVerify = async () => {
    if (!image || !service || stats.length === 0) {
      toast('请先运行 GPU 统计');
      return;
    }
    store.setBusy(true, 'CPU 逐像素参考实现校验中 (抽样 60 个小区)…', 0.1);
    try {
      const cal = (await getCalibrationByImage(image.id))!;
      const expr = compileExpression(exprDef.expr);
      // 从 IDB 读取 level0 全幅反射率 (用于 CPU 参考)
      const raster = await loadFullReflectance(service, image, cal);
      const t0 = performance.now();
      const samplePlots = pickSamples(plots, 60);
      let maxMean = 0;
      let maxMedian = 0;
      const gpuMap = new Map(stats.map((s) => [s.plotId, s]));
      for (const plot of samplePlots) {
        const ref = computePlotStatsCpu(
          raster,
          plot,
          store.gridConfig?.insetPx ?? 4,
          store.settings.mask,
          expr.eval,
          image.id,
          exprDef.name,
          store.settings.flagCloudShadowFraction,
        );
        const gpu = gpuMap.get(plot.id);
        if (!gpu || gpu.flagged || ref.vegPixels === 0) continue;
        maxMean = Math.max(maxMean, relErr(gpu.mean, ref.mean));
        maxMedian = Math.max(maxMedian, relErr(gpu.median, ref.median));
      }
      setVerify({ maxRelErrMean: maxMean, maxRelErrMedian: maxMedian, checked: samplePlots.length, msCpu: performance.now() - t0 });
    } finally {
      store.setBusy(false);
    }
  };

  const runAnova = async () => {
    if (stats.length === 0 || designRows.length === 0) {
      toast('需要统计结果与设计表');
      return;
    }
    const valid = stats.filter((s) => !s.flagged);
    const genotypeOf = new Map(plots.map((p) => {
      const d = designRows.find((r) => r.row === p.row && r.col === p.col);
      return [p.id, d?.genotype ?? p.genotype ?? p.id];
    }));
    const checkSet = new Set(designRows.filter((d) => d.isCheck).map((d) => d.genotype));
    const groupsMap = new Map<string, number[]>();
    for (const s of valid) {
      const g = genotypeOf.get(s.plotId);
      if (!g) continue;
      if (!groupsMap.has(g)) groupsMap.set(g, []);
      groupsMap.get(g)!.push(s.mean);
    }
    const result = oneWayAnova(
      [...groupsMap.entries()].map(([genotype, values]) => ({ genotype, values })),
      exprDef.name,
      image?.date ?? '',
      checkSet,
    );
    setAnova(result);
  };

  const exportStats = () => {
    const rows: (string | number)[][] = [
      ['plotId', 'row', 'col', 'genotype', 'replicate', 'isCheck', 'mean', 'median', 'min', 'max', 'coverage', 'vegPixels', 'cloudShadowFraction', 'flagged'],
    ];
    const dmap = new Map(designRows.map((d) => [`${d.row}/${d.col}`, d]));
    for (const s of stats) {
      const plot = plots.find((p) => p.id === s.plotId);
      const d = plot ? dmap.get(`${plot.row}/${plot.col}`) : undefined;
      rows.push([
        s.plotId, plot?.row ?? '', plot?.col ?? '', d?.genotype ?? plot?.genotype ?? '',
        d?.replicate ?? '', d?.isCheck ? 1 : 0,
        fmt(s.mean), fmt(s.median), fmt(s.min), fmt(s.max),
        s.coverage.toFixed(4), s.vegPixels, s.cloudShadowFraction.toFixed(4), s.flagged ? 1 : 0,
      ]);
    }
    downloadText(`plot_stats_${image?.date}_${exprDef.name}.csv`, toCsv(rows));
  };

  const exportAnova = () => {
    if (!anova) return;
    const rows: (string | number)[][] = [
      [`# 单因素方差分析 ${anova.indexName} ${anova.date}`],
      ['变异来源', 'SS', 'df', 'MS', 'F', 'p'],
      ['组间(品系)', fmt(anova.ssBetween), anova.dfBetween, fmt(anova.msBetween), fmt(anova.f), anova.p.toExponential(3)],
      ['组内(误差)', fmt(anova.ssWithin), anova.dfWithin, fmt(anova.msWithin), '', ''],
      [`LSD(0.05)`, fmt(anova.lsd05), '', '', '', ''],
      [],
      ['品系', 'n', '均值', '标准差', '对照'],
      ...anova.groups.map((g) => [g.genotype, g.n, fmt(g.mean), fmt(g.sd), g.isCheck ? 'CK' : '']),
    ];
    downloadText(`anova_${image?.date}_${exprDef.name}.csv`, toCsv(rows));
  };

  return (
    <div className="page">
      <h2 className="page-title">表型统计</h2>
      <p className="page-sub">GPU 一趟遍历完成全部小区的均值/中位数/覆盖度统计, 内置 CPU 逐像素参考实现做相对误差校验 (门限 0.1%)。</p>

      <div className="card">
        <div className="row">
          <label style={{ margin: 0 }}>影像日期</label>
          <select style={{ width: 260 }} value={image?.id ?? ''} onChange={(e) => setImage(images.find((i) => i.id === e.target.value) ?? null)}>
            {images.map((i) => <option key={i.id} value={i.id}>{i.date} {i.name} {i.calibrationId ? '' : '(未定标)'}</option>)}
          </select>
          <label style={{ margin: 0 }}>指数</label>
          <select style={{ width: 160 }} value={exprName} onChange={(e) => store.setCurrentExpr(e.target.value)}>
            {store.expressions.map((e) => <option key={e.name} value={e.name}>{e.name}</option>)}
          </select>
          <button className="primary" disabled={!caps || !service} onClick={() => void runGpu()}>GPU 统计 ({plots.length} 小区)</button>
          <button disabled={stats.length === 0} onClick={() => void runCpuVerify()}>CPU 参考校验</button>
          <button disabled={stats.length === 0} onClick={() => void runAnova()}>单因素方差分析</button>
          <button disabled={stats.length === 0} onClick={exportStats}>导出小区表</button>
          <button disabled={!anova} onClick={exportAnova}>导出 ANOVA 表</button>
        </div>
        {ms > 0 && <div className="muted" style={{ marginTop: 8 }}>GPU 用时 {formatMs(ms)} (要求 8000 小区 &lt; 3 s)</div>}
        {verify && (
          <div style={{ marginTop: 8 }} className={`tag ${verify.maxRelErrMean < 0.001 && verify.maxRelErrMedian < 0.001 ? 'ok' : 'danger'}`}>
            CPU 校验 ({verify.checked} 小区, CPU 用时 {formatMs(verify.msCpu)}): 均值最大相对误差 {(verify.maxRelErrMean * 100).toFixed(4)}%,
            中位数 {(verify.maxRelErrMedian * 100).toFixed(4)}% (门限 0.1%)
          </div>
        )}
      </div>

      {anova && (
        <div className="card">
          <h3>方差分析结果 (F={fmt(anova.f)}, p={anova.p.toExponential(3)}, LSD05={fmt(anova.lsd05)})</h3>
          <div className="table-wrap" style={{ maxHeight: 260 }}>
            <table>
              <thead><tr><th>品系</th><th>n</th><th>均值</th><th>标准差</th><th></th></tr></thead>
              <tbody>
                {anova.groups.map((g) => (
                  <tr key={g.genotype}>
                    <td>{g.genotype}</td><td>{g.n}</td><td>{fmt(g.mean)}</td><td>{fmt(g.sd)}</td>
                    <td>{g.isCheck ? <span className="tag check">对照</span> : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="card">
        <h3>小区结果 ({stats.length})</h3>
        <div className="table-wrap" style={{ maxHeight: '46vh' }}>
          <table>
            <thead>
              <tr><th>小区</th><th>品系</th><th>均值</th><th>中位数</th><th>最小</th><th>最大</th><th>覆盖度</th><th>有效像素</th><th>云影占比</th><th>标记</th></tr>
            </thead>
            <tbody>
              {stats.slice(0, 500).map((s) => {
                const plot = plots.find((p) => p.id === s.plotId);
                const d = plot ? designRows.find((r) => r.row === plot.row && r.col === plot.col) : undefined;
                return (
                  <tr key={s.plotId} style={s.flagged ? { opacity: 0.55 } : undefined}>
                    <td>{plot ? `${plot.row + 1}-${plot.col + 1}` : s.plotId}</td>
                    <td>{d?.isCheck ? <span className="tag check">{d.genotype}</span> : d?.genotype ?? '—'}</td>
                    <td>{fmt(s.mean)}</td><td>{fmt(s.median)}</td><td>{fmt(s.min)}</td><td>{fmt(s.max)}</td>
                    <td>{(s.coverage * 100).toFixed(1)}%</td><td>{s.vegPixels}</td>
                    <td>{(s.cloudShadowFraction * 100).toFixed(1)}%</td>
                    <td>{s.flagged ? <span className="tag danger">云影剔除</span> : <span className="tag ok">有效</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {stats.length > 500 && <div className="muted" style={{ marginTop: 6 }}>仅显示前 500 行, 导出 CSV 含全部 {stats.length} 个小区</div>}
      </div>
    </div>
  );
}

function relErr(a: number, b: number): number {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return 0;
  return Math.abs(a - b) / Math.max(Math.abs(b), 1e-9);
}
function fmt(v: number): string {
  return Number.isFinite(v) ? v.toFixed(5) : '';
}
function pickSamples(plots: Plot[], n: number): Plot[] {
  if (plots.length <= n) return plots;
  const step = Math.floor(plots.length / n);
  const out: Plot[] = [];
  for (let i = 0; i < plots.length && out.length < n; i += step) out.push(plots[i]);
  return out;
}

/** 从 IDB 切片拼装 level0 全幅反射率平面 (CPU 参考实现用) */
async function loadFullReflectance(
  service: NonNullable<ReturnType<typeof useRasterService>>,
  image: FlightImage,
  cal: { gains: number[]; offsets: number[] },
) {
  const ts = image.tileSize;
  const tilesX = Math.ceil(image.width / ts);
  const tilesY = Math.ceil(image.height / ts);
  const bands = Array.from({ length: 5 }, () => new Float32Array(image.width * image.height));
  for (let ty = 0; ty < tilesY; ty++) {
    for (let tx = 0; tx < tilesX; tx++) {
      const tile = await service.fetchTile(0, ty, tx);
      for (let ly = 0; ly < ts; ly++) {
        const py = ty * ts + ly;
        if (py >= image.height) break;
        for (let lx = 0; lx < ts; lx++) {
          const px = tx * ts + lx;
          if (px >= image.width) break;
          for (let b = 0; b < 5; b++) {
            const dn = tile[(ly * ts + lx) * 5 + b];
            bands[b][py * image.width + px] = cal.gains[b] * dn + cal.offsets[b];
          }
        }
      }
    }
  }
  return { width: image.width, height: image.height, bands };
}
