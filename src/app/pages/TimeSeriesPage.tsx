import { useEffect, useMemo, useState } from 'react';
import { useAppStore } from '../../state/store';
import {
  getStats,
  listGcps,
  listImages,
  putImage,
  saveGcps,
} from '../../db/idb';
import { estimateHeadingDate, daysBetween, type TimePoint } from '../../core/stats';
import { fitAffine, IDENTITY_AFFINE, invertAffine, applyAffine } from '../../core/geometry';
import { toast } from '../components/Toast';
import { toCsv, downloadText } from '../../core/util';
import type { FlightImage, GcpPoint, PlotStats } from '../../types';
import { uid } from '../../core/util';

export function TimeSeriesPage() {
  const store = useAppStore();
  const [images, setImages] = useState<FlightImage[]>([]);
  const [overlayId, setOverlayId] = useState<string | null>(null);
  const [gcps, setGcps] = useState<(GcpPoint & { imageId: string })[]>([]);
  const [seriesCache, setSeriesCache] = useState<Record<string, PlotStats[]>>({});
  const [selectedGenotypes, setSelectedGenotypes] = useState<string[]>([]);
  const [heading, setHeading] = useState<Record<string, { date: string; t: number } | null>>({});

  const baseImage = images[0] ?? null;
  const exprName = store.currentExprName;

  useEffect(() => {
    if (!store.currentExperimentId) return;
    void listImages(store.currentExperimentId).then(setImages);
  }, [store.currentExperimentId]);

  useEffect(() => {
    if (!overlayId) {
      setGcps([]);
      return;
    }
    void listGcps(overlayId).then(setGcps);
  }, [overlayId]);

  // 拉取各期该指数的统计
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const cache: Record<string, PlotStats[]> = {};
      for (const img of images) {
        const rows = await getStats(img.id, exprName);
        if (cancelled) return;
        if (rows.length > 0) cache[img.id] = rows;
      }
      setSeriesCache(cache);
    })();
    return () => {
      cancelled = true;
    };
  }, [images, exprName]);

  const genotypeSeries = useMemo(() => {
    const plots = store.plots;
    const out = new Map<string, { date: string; value: number; n: number }[]>();
    for (const img of images) {
      const rows = seriesCache[img.id];
      if (!rows) continue;
      const byId = new Map(rows.map((r) => [r.plotId, r]));
      const acc = new Map<string, { sum: number; n: number }>();
      for (const p of plots) {
        const key = p.genotype ?? p.id;
        const s = byId.get(p.id);
        if (!s || s.flagged) continue;
        const a = acc.get(key) ?? { sum: 0, n: 0 };
        a.sum += s.mean;
        a.n += 1;
        acc.set(key, a);
      }
      for (const [g, a] of acc) {
        const arr = out.get(g) ?? [];
        arr.push({ date: img.date, value: a.sum / a.n, n: a.n });
        out.set(g, arr);
      }
    }
    return out;
  }, [seriesCache, images, store.plots]);

  const allGenotypes = useMemo(() => [...genotypeSeries.keys()].sort(), [genotypeSeries]);
  useEffect(() => {
    if (selectedGenotypes.length === 0 && allGenotypes.length > 0) {
      setSelectedGenotypes(allGenotypes.slice(0, Math.min(8, allGenotypes.length)));
    }
  }, [allGenotypes]);

  const baseDate = baseImage?.date;
  const timePoints = useMemo(() => {
    const m = new Map<string, TimePoint[]>();
    for (const [g, rows] of genotypeSeries) {
      if (!baseDate) continue;
      m.set(g, rows.map((r) => ({ date: r.date, t: daysBetween(baseDate, r.date), value: r.value })));
    }
    return m;
  }, [genotypeSeries, baseDate]);

  useEffect(() => {
    const h: Record<string, { date: string; t: number } | null> = {};
    for (const [g, pts] of timePoints) h[g] = estimateHeadingDate(pts);
    setHeading(h);
  }, [timePoints]);

  const addGcp = async () => {
    if (!overlayId || !baseImage) return;
    // 在基准影像和叠加影像中心各放一个可拖动控制点 (简化: 用数值输入)
    const bx = prompt(`基准影像 (${baseImage.date}) X 坐标:`, String(baseImage.width / 2));
    const by = prompt(`基准影像 Y 坐标:`, String(baseImage.height / 2));
    const ix = prompt(`配准影像 X 坐标:`, String(baseImage.width / 2 + 8));
    const iy = prompt(`配准影像 Y 坐标:`, String(baseImage.height / 2));
    if (!bx || !by || !ix || !iy) return;
    const point: GcpPoint & { imageId: string } = {
      id: uid('gcp'),
      imageId: overlayId,
      baseX: Number(bx),
      baseY: Number(by),
      imageX: Number(ix),
      imageY: Number(iy),
    };
    const next = [...gcps, point];
    setGcps(next);
    await saveGcps(overlayId, next);
    toast(`控制点 ${next.length} 个, 至少 3 个可拟合仿射配准`, 'info');
  };

  const fitRegistration = async () => {
    if (!overlayId || gcps.length < 3) {
      toast('至少需要 3 个控制点');
      return;
    }
    // 拟合: 基准坐标 -> 影像坐标
    const model = fitAffine(gcps.map((g) => ({ sx: g.baseX, sy: g.baseY, dx: g.imageX, dy: g.imageY })));
    const img = images.find((i) => i.id === overlayId);
    if (!img) return;
    await putImage({ ...img, registration: model });
    setImages(images.map((i) => (i.id === overlayId ? { ...i, registration: model } : i)));
    toast(`配准仿射已保存: a=${model.a.toFixed(4)} b=${model.b.toFixed(4)} c=${model.c.toFixed(2)}…`, 'info');
  };

  const resetRegistration = async () => {
    if (!overlayId) return;
    const img = images.find((i) => i.id === overlayId);
    if (!img) return;
    const { registration, ...rest } = img;
    void registration;
    await putImage(rest as FlightImage);
    setImages(images.map((i) => (i.id === overlayId ? (rest as FlightImage) : i)));
  };

  const exportSeries = () => {
    const dates = images.map((i) => i.date);
    const rows: (string | number)[][] = [
      ['genotype', ...dates, 'headingEstimate'],
    ];
    for (const [g, pts] of genotypeSeries) {
      const byDate = new Map(pts.map((p) => [p.date, p.value]));
      rows.push([g, ...dates.map((d) => byDate.get(d) ?? ''), heading[g]?.date ?? '']);
    }
    downloadText(`timeseries_${exprName}.csv`, toCsv(rows));
  };

  const regInfo = overlayId ? images.find((i) => i.id === overlayId)?.registration : undefined;

  return (
    <div className="page">
      <h2 className="page-title">时序对比</h2>
      <p className="page-sub">多飞行日期指数时序、控制点配准和抽穗期拐点估计。云影标记的小区数据自动排除在汇总之外。</p>

      <div className="grid cols-2">
        <div className="card">
          <h3>影像配准 (基准: {baseImage?.date ?? '—'})</h3>
          <select value={overlayId ?? ''} onChange={(e) => setOverlayId(e.target.value || null)}>
            <option value="">选择待配准影像…</option>
            {images.slice(1).map((i) => <option key={i.id} value={i.id}>{i.date} {i.name}</option>)}
          </select>
          <div className="row" style={{ marginTop: 10 }}>
            <button onClick={() => void addGcp()} disabled={!overlayId}>添加控制点</button>
            <button className="primary" onClick={() => void fitRegistration()} disabled={gcps.length < 3}>拟合仿射 ({gcps.length})</button>
            <button onClick={() => void resetRegistration()} disabled={!regInfo}>重置配准</button>
          </div>
          <div className="muted" style={{ marginTop: 8 }}>
            {regInfo ? `已配准: ${JSON.stringify({ a: regInfo.a, b: regInfo.b, c: round(regInfo.c), d: regInfo.d, e: regInfo.e, f: round(regInfo.f) })}` : '未配准 (恒等变换)'}
          </div>
          <table style={{ marginTop: 10 }}>
            <thead><tr><th>#</th><th>基准 X/Y</th><th>影像 X/Y</th><th>残差</th></tr></thead>
            <tbody>
              {gcps.map((g, i) => {
                let resid = '';
                if (regInfo) {
                  const [px, py] = applyAffine(invertAffine(regInfo), g.imageX, g.imageY);
                  resid = `${Math.hypot(px - g.baseX, py - g.baseY).toFixed(2)} px`;
                }
                return (
                  <tr key={g.id}>
                    <td>{i + 1}</td>
                    <td>{g.baseX.toFixed(1)}, {g.baseY.toFixed(1)}</td>
                    <td>{g.imageX.toFixed(1)}, {g.imageY.toFixed(1)}</td>
                    <td>{resid || '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="muted" style={{ marginTop: 6 }}>
            {images.length} 期影像, 其中 {images.filter((i) => i.registration).length} 期已配准;
            恒等变换基准 {JSON.stringify(IDENTITY_AFFINE) !== '{}' ? '可用' : ''}
          </div>
        </div>

        <div className="card">
          <h3>品系选择 ({allGenotypes.length} 个品系)</h3>
          <div className="pill-btns" style={{ maxHeight: 180, overflow: 'auto' }}>
            {allGenotypes.map((g) => (
              <button
                key={g}
                className={selectedGenotypes.includes(g) ? 'active' : ''}
                onClick={() => setSelectedGenotypes((prev) => (prev.includes(g) ? prev.filter((x) => x !== g) : [...prev, g]))}
              >
                {g}
              </button>
            ))}
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <button onClick={() => setSelectedGenotypes(allGenotypes.slice(0, 8))}>前 8 个</button>
            <button onClick={() => setSelectedGenotypes([])}>全不选</button>
            <button className="primary" onClick={exportSeries}>导出时序 CSV</button>
          </div>
        </div>
      </div>

      <div className="card">
        <h3>{exprName} 时序曲线</h3>
        <SeriesChart timePoints={timePoints} selected={selectedGenotypes} heading={heading} />
      </div>

      <div className="card">
        <h3>抽穗期估计 (曲线最大一阶差分拐点)</h3>
        <div className="table-wrap" style={{ maxHeight: 280 }}>
          <table>
            <thead><tr><th>品系</th><th>估计抽穗日期</th><th>距首日天数</th><th>数据点</th></tr></thead>
            <tbody>
              {allGenotypes.filter((g) => selectedGenotypes.includes(g)).map((g) => (
                <tr key={g}>
                  <td>{g}</td>
                  <td>{heading[g]?.date ?? '点数不足'}</td>
                  <td>{heading[g]?.t.toFixed(1) ?? '—'}</td>
                  <td>{timePoints.get(g)?.length ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}

function SeriesChart({ timePoints, selected, heading }: {
  timePoints: Map<string, TimePoint[]>;
  selected: string[];
  heading: Record<string, { date: string; t: number } | null>;
}) {
  const W = 900;
  const H = 320;
  const pad = 48;
  const allPts = selected.flatMap((g) => timePoints.get(g) ?? []);
  if (allPts.length === 0) return <div className="muted">暂无统计数据, 请先在「表型统计」页对各期影像运行 GPU 统计</div>;
  const maxT = Math.max(...allPts.map((p) => p.t), 1);
  const vals = allPts.map((p) => p.value);
  const minV = Math.min(...vals);
  const maxV = Math.max(...vals);
  const x = (t: number) => pad + (t / maxT) * (W - pad * 2);
  const y = (v: number) => H - pad - ((v - minV) / Math.max(maxV - minV, 1e-9)) * (H - pad * 2);
  const colors = ['#4da3ff', '#2ecc8f', '#f0a020', '#ef5f6b', '#a78bfa', '#ffd34d', '#22d3ee', '#f472b6'];
  const dates = [...new Set(allPts.map((p) => p.date))].sort();
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`}>
      {[0, 0.25, 0.5, 0.75, 1].map((f) => (
        <g key={f}>
          <line x1={pad} x2={W - pad} y1={pad + f * (H - pad * 2)} y2={pad + f * (H - pad * 2)} stroke="#314052" strokeDasharray="3 3" />
          <text x={8} y={pad + f * (H - pad * 2) + 4} fill="#93a4b5" fontSize={10}>{(maxV - f * (maxV - minV)).toFixed(3)}</text>
        </g>
      ))}
      {dates.map((d, i) => (
        <text key={d} x={pad + (i / Math.max(dates.length - 1, 1)) * (W - pad * 2)} y={H - 16} fill="#93a4b5" fontSize={10} textAnchor="middle">{d.slice(5)}</text>
      ))}
      {selected.map((g, gi) => {
        const pts = timePoints.get(g) ?? [];
        const path = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.t)},${y(p.value)}`).join(' ');
        const color = colors[gi % colors.length];
        const hd = heading[g];
        return (
          <g key={g}>
            <path d={path} fill="none" stroke={color} strokeWidth={2} />
            {pts.map((p) => <circle key={p.date} cx={x(p.t)} cy={y(p.value)} r={3.5} fill={color} />)}
            {hd && <line x1={x(hd.t)} x2={x(hd.t)} y1={pad} y2={H - pad} stroke={color} strokeDasharray="5 4" opacity={0.5} />}
          </g>
        );
      })}
    </svg>
  );
}
