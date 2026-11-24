import { useState } from 'react';
import { useAppStore } from '../../state/store';
import { compileExpression, ExpressionError } from '../../core/expression';
import { buildLut, COLORMAPS, sampleColormap } from '../../core/colormap';
import { clearAll, estimateStorage } from '../../db/idb';
import { disposeGpuSingleton } from '../services/gpu-hooks';
import { toast } from '../components/Toast';
import { formatBytes } from '../../core/util';

export function SettingsPage() {
  const { settings, setSettings, expressions, setExpressions, currentExprName, setCurrentExpr } = useAppStore();
  const [name, setName] = useState('');
  const [expr, setExpr] = useState('');
  const [storage, setStorage] = useState({ usage: 0, quota: 0 });
  const [testResult, setTestResult] = useState<string | null>(null);

  const refreshStorage = () => void estimateStorage().then(setStorage);
  useState(() => {
    refreshStorage();
    return null;
  });

  const setMask = (patch: Partial<typeof settings.mask>) => setSettings({ ...settings, mask: { ...settings.mask, ...patch } });

  const addExpression = () => {
    if (!name.trim() || !expr.trim()) {
      toast('名称和表达式都要填');
      return;
    }
    try {
      compileExpression(expr);
    } catch (e) {
      toast(e instanceof ExpressionError ? `编译失败: ${e.message} (位置 ${e.pos})` : String(e));
      return;
    }
    if (expressions.some((e) => e.name === name.trim())) {
      toast('该指数名称已存在');
      return;
    }
    setExpressions([...expressions, { name: name.trim(), label: name.trim(), expr: expr.trim(), builtin: false }]);
    setName('');
    setExpr('');
    toast('表达式已保存, 下次进入影像浏览即可选用并实时编译为着色器', 'info');
  };

  const removeExpression = (n: string) => {
    const target = expressions.find((e) => e.name === n);
    if (target?.builtin) {
      toast('内置指数不可删除');
      return;
    }
    setExpressions(expressions.filter((e) => e.name !== n));
    if (currentExprName === n) setCurrentExpr('NDVI');
  };

  const testExpr = () => {
    try {
      const c = compileExpression(expr || '(NIR - R) / (NIR + R)');
      const v = c.eval([0.08, 0.13, 0.09, 0.25, 0.5]);
      setTestResult(`编译通过 ✓ 示例输入求值 = ${v.toFixed(5)}; WGSL: ${c.wgsl.slice(0, 80)}…`);
    } catch (e) {
      setTestResult(`编译失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const wipe = async () => {
    if (!confirm('清空 IndexedDB 中全部数据 (试验/影像/切片/统计)? 不可恢复。')) return;
    disposeGpuSingleton();
    await clearAll();
    refreshStorage();
    toast('已清空全部本地数据', 'info');
  };

  return (
    <div className="page">
      <h2 className="page-title">设置</h2>
      <p className="page-sub">掩膜阈值、缓存预算与自定义波段运算表达式。所有参数持久化在 IndexedDB。</p>

      <div className="grid cols-2">
        <div className="card">
          <h3>云影 / 土壤掩膜阈值 (反射率)</h3>
          <div className="grid cols-2">
            <Slider label={`土壤 NDVI 下限: ${settings.mask.soilNDVI}`} min={0} max={0.6} step={0.01} value={settings.mask.soilNDVI} onChange={(v) => setMask({ soilNDVI: v })} />
            <Slider label={`云亮度阈值: ${settings.mask.cloudBright}`} min={0.3} max={0.9} step={0.01} value={settings.mask.cloudBright} onChange={(v) => setMask({ cloudBright: v })} />
            <Slider label={`阴影暗度阈值: ${settings.mask.shadowDark}`} min={0.01} max={0.2} step={0.005} value={settings.mask.shadowDark} onChange={(v) => setMask({ shadowDark: v })} />
            <Slider label={`云影剔除占比门限: ${(settings.flagCloudShadowFraction * 100).toFixed(0)}%`} min={0.02} max={0.5} step={0.01} value={settings.flagCloudShadowFraction} onChange={(v) => setSettings({ ...settings, flagCloudShadowFraction: v })} />
          </div>
          <h3 style={{ marginTop: 20 }}>色带拉伸百分位</h3>
          <div className="grid cols-2">
            <Slider label={`低端: ${settings.histogramLowPct}%`} min={0} max={10} step={0.5} value={settings.histogramLowPct} onChange={(v) => setSettings({ ...settings, histogramLowPct: v })} />
            <Slider label={`高端: ${settings.histogramHighPct}%`} min={90} max={100} step={0.5} value={settings.histogramHighPct} onChange={(v) => setSettings({ ...settings, histogramHighPct: v })} />
          </div>
        </div>

        <div className="card">
          <h3>缓存预算 (防止内存涨爆)</h3>
          <div className="grid cols-2">
            <Slider label={`内存切片缓存: ${settings.ramCacheBudgetMB} MB`} min={32} max={512} step={16} value={settings.ramCacheBudgetMB} onChange={(v) => setSettings({ ...settings, ramCacheBudgetMB: v })} />
            <Slider label={`GPU 纹理缓存: ${settings.gpuMemoryBudgetMB} MB`} min={64} max={1024} step={32} value={settings.gpuMemoryBudgetMB} onChange={(v) => setSettings({ ...settings, gpuMemoryBudgetMB: v })} />
          </div>
          <div className="muted" style={{ marginTop: 8 }}>
            两级 LRU 均为硬预算: 超预算立即淘汰最久未用切片; 切换影像时定向释放旧影像缓存。
          </div>
          <h3 style={{ marginTop: 20 }}>色带</h3>
          <div className="pill-btns">
            {Object.keys(COLORMAPS).map((name) => (
              <button key={name} className={settings.colormap === name ? 'active' : ''} onClick={() => setSettings({ ...settings, colormap: name })}>{name}</button>
            ))}
          </div>
          <ColorPreview name={settings.colormap} />
          <h3 style={{ marginTop: 20 }}>存储</h3>
          <div className="muted">IndexedDB 占用 {formatBytes(storage.usage)} / 配额 {formatBytes(storage.quota)}</div>
          <button className="danger" style={{ marginTop: 8 }} onClick={() => void wipe()}>清空全部本地数据</button>
        </div>
      </div>

      <div className="card">
        <h3>自定义波段表达式</h3>
        <div className="muted" style={{ marginBottom: 8 }}>
          可用波段: B, G, R, RE, NIR; 运算符 + - * /; 函数 abs sqrt exp log min max pow clamp。除零自动安全返回 0。
        </div>
        <div className="grid cols-3">
          <div><label>指数名称</label><input value={name} onChange={(e) => setName(e.target.value)} placeholder="如 MCARI" /></div>
          <div style={{ gridColumn: 'span 2' }}><label>表达式</label><input value={expr} onChange={(e) => setExpr(e.target.value)} placeholder="如 (RE - R) - 0.2 * (RE - G)" /></div>
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <button onClick={testExpr}>编译测试</button>
          <button className="primary" onClick={addExpression}>保存表达式</button>
          {testResult && <span className="tag ok">{testResult}</span>}
        </div>
        <div className="table-wrap" style={{ marginTop: 12 }}>
          <table>
            <thead><tr><th>名称</th><th>表达式</th><th>类型</th><th></th></tr></thead>
            <tbody>
              {expressions.map((e) => (
                <tr key={e.name}>
                  <td>{e.name}</td><td>{e.expr}</td>
                  <td>{e.builtin ? <span className="tag">内置</span> : <span className="tag ok">自定义</span>}</td>
                  <td>
                    <button onClick={() => { setName(e.name); setExpr(e.expr); }}>编辑</button>{' '}
                    <button className="danger" onClick={() => removeExpression(e.name)}>删除</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Slider({ label, min, max, step, value, onChange }: { label: string; min: number; max: number; step: number; value: number; onChange: (v: number) => void }) {
  return (
    <div>
      <label>{label}</label>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </div>
  );
}

function ColorPreview({ name }: { name: string }) {
  const lut = buildLut(name);
  void sampleColormap;
  return (
    <div
      className="legend-bar"
      style={{ marginTop: 10, background: `linear-gradient(90deg, ${[0, 0.2, 0.4, 0.6, 0.8, 1].map((t) => {
        const i = Math.round(t * 255) * 4;
        return `rgb(${lut[i]},${lut[i + 1]},${lut[i + 2]})`;
      }).join(',')})` }}
    />
  );
}
