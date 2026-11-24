import { useState } from 'react';
import { runSelftest, type SelftestResult } from '../services/selftest';

export function SelftestPage() {
  const [logs, setLogs] = useState<string[]>([]);
  const [result, setResult] = useState<SelftestResult | null>(null);
  const [running, setRunning] = useState(false);

  const run = async () => {
    setRunning(true);
    setLogs([]);
    setResult(null);
    try {
      const r = await runSelftest((msg) => {
        // eslint-disable-next-line no-console
        console.log('[selftest]', msg);
        setLogs((prev) => [...prev, msg]);
      });
      setResult(r);
      (window as unknown as { __SELFTEST_RESULT__: SelftestResult }).__SELFTEST_RESULT__ = r;
    } catch (e) {
      const msg = e instanceof Error ? `${e.name}: ${e.message}\n${e.stack ?? ''}` : String(e);
      setLogs((prev) => [...prev, `致命错误: ${msg}`]);
      (window as unknown as { __SELFTEST_ERROR__: string }).__SELFTEST_ERROR__ = msg;
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="page">
      <h2 className="page-title">系统自检 (WebGPU 精度/性能/内存)</h2>
      <p className="page-sub">
        在真实 GPU 上运行: ① GPU vs CPU 逐像素参考相对误差 &lt;0.1%; ② 8000 小区统计 &lt;3s; ③ 三景切换缓存不超预算。
      </p>
      <div className="card">
        <button className="primary" disabled={running} onClick={() => void run()}>
          {running ? '自检运行中…' : '运行全套自检'}
        </button>
      </div>
      <div className="card">
        <h3>日志</h3>
        <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, lineHeight: 1.7, maxHeight: 300, overflow: 'auto' }}>
          {logs.join('\n')}
        </pre>
      </div>
      {result && (
        <div className="card">
          <h3>结果 {result.ok ? '✅ 全部通过' : '❌ 存在失败项'}</h3>
          <table>
            <tbody>
              <tr><td>GPU f32 原子</td><td>{result.webgpu.f32Atomic ? '支持' : '不支持'}</td></tr>
              {result.accuracy && (
                <tr>
                  <td>精度 ({result.accuracy.plots} 小区)</td>
                  <td className={result.accuracy.pass ? 'tag ok' : 'tag danger'}>
                    均值相对误差 {(result.accuracy.maxRelErrMean * 100).toFixed(5)}% / 中位数 {(result.accuracy.maxRelErrMedian * 100).toFixed(5)}% / 像素差 {result.accuracy.maxPixelCountDiff}
                  </td>
                </tr>
              )}
              {result.performance8000 && (
                <tr>
                  <td>8000 小区性能</td>
                  <td className={result.performance8000.pass ? 'tag ok' : 'tag danger'}>
                    {result.performance8000.elapsedMs.toFixed(0)} ms (门限 3000 ms)
                  </td>
                </tr>
              )}
              {result.memory && (
                <tr>
                  <td>内存/显存</td>
                  <td className={result.memory.pass ? 'tag ok' : 'tag danger'}>
                    RAM 峰值 {result.memory.ramPeakMB.toFixed(1)}/{result.memory.ramBudgetMB} MB · 显存峰值 {result.memory.gpuPeakMB.toFixed(1)}/{result.memory.gpuBudgetMB} MB
                  </td>
                </tr>
              )}
              {result.histogram && (
                <tr><td>直方图</td><td className={result.histogram.pass ? 'tag ok' : 'tag danger'}>值域 [{result.histogram.lo}, {result.histogram.hi}]</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
