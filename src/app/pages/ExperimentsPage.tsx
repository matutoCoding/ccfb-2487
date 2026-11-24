import { useEffect, useState } from 'react';
import { useAppStore } from '../../state/store';
import { deleteExperiment, listExperiments, putExperiment, estimateStorage } from '../../db/idb';
import { uid, formatBytes } from '../../core/util';
import { toast } from '../components/Toast';
import type { Experiment } from '../../types';
import { generateDemoDataset } from '../services/demo-data';

export function ExperimentsPage() {
  const { experiments, setExperiments, setCurrentExperiment, currentExperimentId, setBusy } = useAppStore();
  const [name, setName] = useState('');
  const [crop, setCrop] = useState('小麦');
  const [season, setSeason] = useState('2026 春季');
  const [design, setDesign] = useState<Experiment['design']>('RCBD');
  const [storage, setStorage] = useState({ usage: 0, quota: 0 });

  const refresh = () => {
    void listExperiments().then((rows) => {
      setExperiments(rows);
      if (!currentExperimentId && rows[0]) setCurrentExperiment(rows[0].id);
    });
    void estimateStorage().then(setStorage);
  };
  useEffect(refresh, []);

  const create = async () => {
    if (!name.trim()) {
      toast('请填写试验名称');
      return;
    }
    const exp: Experiment = {
      id: uid('exp'),
      name: name.trim(),
      crop,
      season,
      design,
      createdAt: Date.now(),
    };
    await putExperiment(exp);
    setName('');
    setCurrentExperiment(exp.id);
    refresh();
    toast(`试验「${exp.name}」已创建`, 'info');
  };

  const remove = async (id: string) => {
    if (!confirm('删除试验将同时删除其全部影像、切片与统计结果, 确定吗?')) return;
    await deleteExperiment(id);
    if (currentExperimentId === id) setCurrentExperiment(null);
    refresh();
  };

  const demo = async () => {
    setBusy(true, '生成合成测试影像并构建金字塔…', 0.05);
    try {
      const expId = await generateDemoDataset((stage, pct) => setBusy(true, stage, pct));
      setCurrentExperiment(expId);
      refresh();
      toast('演示数据集生成完成: 3 个飞行日期, 含定标板/云影/小区纹理', 'info');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <h2 className="page-title">试验列表</h2>
      <p className="page-sub">管理育种试验。每个试验包含多期飞行影像、一套小区网格和田间设计表。</p>

      <div className="card">
        <h3>新建试验</h3>
        <div className="grid cols-4">
          <div>
            <label>试验名称</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="如: 2026 小麦品比试验 A" />
          </div>
          <div>
            <label>作物</label>
            <input value={crop} onChange={(e) => setCrop(e.target.value)} />
          </div>
          <div>
            <label>季节</label>
            <input value={season} onChange={(e) => setSeason(e.target.value)} />
          </div>
          <div>
            <label>田间设计</label>
            <select value={design} onChange={(e) => setDesign(e.target.value as Experiment['design'])}>
              <option value="RCBD">随机区组 (RCBD)</option>
              <option value="RANDOM">完全随机</option>
              <option value="GRID">规则网格</option>
            </select>
          </div>
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <button className="primary" onClick={() => void create()}>创建试验</button>
          <button onClick={() => void demo()}>一键生成演示数据集 (3 期合成影像)</button>
          <span className="spacer" />
          <span className="muted">
            IndexedDB 占用 {formatBytes(storage.usage)} / 配额 {formatBytes(storage.quota)}
          </span>
        </div>
      </div>

      <div className="card">
        <h3>已有试验 ({experiments.length})</h3>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>名称</th><th>作物</th><th>季节</th><th>设计</th><th>创建时间</th><th></th>
              </tr>
            </thead>
            <tbody>
              {experiments.map((e) => (
                <tr key={e.id} style={e.id === currentExperimentId ? { outline: '1px solid var(--accent)' } : undefined}>
                  <td>{e.name}</td>
                  <td>{e.crop}</td>
                  <td>{e.season}</td>
                  <td><span className="tag">{e.design}</span></td>
                  <td>{new Date(e.createdAt).toLocaleString()}</td>
                  <td>
                    <button onClick={() => setCurrentExperiment(e.id)}>选择</button>{' '}
                    <button className="danger" onClick={() => void remove(e.id)}>删除</button>
                  </td>
                </tr>
              ))}
              {experiments.length === 0 && (
                <tr><td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 24 }}>暂无试验, 点击上方按钮创建或生成演示数据</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
