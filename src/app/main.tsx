import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter, NavLink, Route, Routes, Navigate } from 'react-router-dom';
import '../styles.css';
import { useAppStore } from '../state/store';
import { ExperimentsPage } from './pages/ExperimentsPage';
import { ImagesPage } from './pages/ImagesPage';
import { GridPage } from './pages/GridPage';
import { StatsPage } from './pages/StatsPage';
import { TimeSeriesPage } from './pages/TimeSeriesPage';
import { SettingsPage } from './pages/SettingsPage';
import { SelftestPage } from './pages/SelftestPage';
import { BusyOverlay } from './components/BusyOverlay';
import { ToastHost } from './components/Toast';

const NAV = [
  { to: '/experiments', label: '试验列表' },
  { to: '/images', label: '影像浏览' },
  { to: '/grid', label: '小区网格' },
  { to: '/stats', label: '表型统计' },
  { to: '/timeseries', label: '时序对比' },
  { to: '/settings', label: '设置' },
  { to: '/selftest', label: '系统自检' },
];

function Shell() {
  const hydrate = useAppStore((s) => s.hydrate);
  React.useEffect(() => {
    void hydrate();
  }, [hydrate]);
  return (
    <div className="app-shell">
      <nav className="sidebar">
        <div className="brand">🌾 育种表型系统</div>
        {NAV.map((n) => (
          <NavLink key={n.to} to={n.to} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
            {n.label}
          </NavLink>
        ))}
      </nav>
      <main className="main">
        <Routes>
          <Route path="/" element={<Navigate to="/experiments" replace />} />
          <Route path="/experiments" element={<ExperimentsPage />} />
          <Route path="/images" element={<ImagesPage />} />
          <Route path="/grid" element={<GridPage />} />
          <Route path="/stats" element={<StatsPage />} />
          <Route path="/timeseries" element={<TimeSeriesPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/selftest" element={<SelftestPage />} />
        </Routes>
      </main>
      <BusyOverlay />
      <ToastHost />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <HashRouter>
      <Shell />
    </HashRouter>
  </React.StrictMode>,
);
