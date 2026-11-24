import { useAppStore } from '../../state/store';

export function BusyOverlay() {
  const busy = useAppStore((s) => s.busy);
  if (!busy.active) return null;
  return (
    <div className="progress-overlay">
      <div className="progress-box">
        <div>{busy.message || '处理中…'}</div>
        <div className="progress-bar">
          <div style={{ width: `${Math.round(busy.pct * 100)}%` }} />
        </div>
        <div className="muted" style={{ marginTop: 8 }}>{Math.round(busy.pct * 100)}%</div>
      </div>
    </div>
  );
}
