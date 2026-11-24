import { useEffect, useRef } from 'react';
import type { GcpPoint, Plot } from '../../types';
import { plotCorners } from '../../core/geometry';
import { worldToScreen, type Camera } from './camera';

export interface OverlayCanvasProps {
  imageWidth: number;
  imageHeight: number;
  camera: Camera;
  plots: Plot[];
  checkPlots: Set<string>;
  gcps: GcpPoint[];
  showPlots: boolean;
  showCloudMask?: boolean;
  maskCanvas?: HTMLCanvasElement | null;
  selectedPlotId?: string | null;
  onSelectPlot?: (plot: Plot | null) => void;
}

export function OverlayCanvas(props: OverlayCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const rafRef = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current!;
    let disposed = false;
    const resize = () => {
      const parent = canvas.parentElement!;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.max(1, Math.floor(parent.clientWidth * dpr));
      const h = Math.max(1, Math.floor(parent.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
    };
    const ro = new ResizeObserver(resize);
    ro.observe(canvas.parentElement!);

    const draw = () => {
      if (disposed) return;
      const p = propsRef.current;
      resize();
      const ctx = canvas.getContext('2d')!;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const viewW = canvas.width / dpr;
      const viewH = canvas.height / dpr;
      ctx.clearRect(0, 0, viewW, viewH);

      if (p.showPlots) {
        for (const plot of p.plots) {
          const corners = plotCorners(plot).map(([x, y]) => worldToScreen(p.camera, viewW, viewH, x, y));
          const isCheck = p.checkPlots.has(plot.id);
          const isSel = p.selectedPlotId === plot.id;
          ctx.beginPath();
          ctx.moveTo(corners[0][0], corners[0][1]);
          for (let i = 1; i < 4; i++) ctx.lineTo(corners[i][0], corners[i][1]);
          ctx.closePath();
          ctx.lineWidth = isSel ? 2.2 : 1;
          ctx.strokeStyle = isSel ? '#ffffff' : isCheck ? '#ffd34d' : 'rgba(120,200,255,0.85)';
          ctx.stroke();
          if (isCheck) {
            ctx.fillStyle = 'rgba(255,211,77,0.12)';
            ctx.fill();
          }
          if (p.camera.scale > 0.6) {
            const [sx, sy] = worldToScreen(p.camera, viewW, viewH, plot.cx, plot.cy);
            ctx.fillStyle = 'rgba(230,237,243,0.85)';
            ctx.font = '10px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(`${plot.row + 1}-${plot.col + 1}`, sx, sy);
          }
        }
      }

      for (const g of p.gcps) {
        const [sx, sy] = worldToScreen(p.camera, viewW, viewH, g.imageX, g.imageY);
        ctx.beginPath();
        ctx.arc(sx, sy, 6, 0, Math.PI * 2);
        ctx.strokeStyle = '#ff6b6b';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(sx - 9, sy);
        ctx.lineTo(sx + 9, sy);
        ctx.moveTo(sx, sy - 9);
        ctx.lineTo(sx, sy + 9);
        ctx.stroke();
      }
      rafRef.current = requestAnimationFrame(draw);
    };
    rafRef.current = requestAnimationFrame(draw);
    return () => {
      disposed = true;
      cancelAnimationFrame(rafRef.current);
      ro.disconnect();
    };
  }, []);

  const handleClick = (e: React.MouseEvent) => {
    const p = propsRef.current;
    if (!p.onSelectPlot) return;
    const el = canvasRef.current!;
    const rect = el.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    // 屏幕 -> 世界, 命中测试 (从后往前, 优先上层)
    for (let i = p.plots.length - 1; i >= 0; i--) {
      const plot = p.plots[i];
      const corners = plotCorners(plot).map(([x, y]) => worldToScreen(p.camera, rect.width, rect.height, x, y));
      if (pointInPolygon(sx, sy, corners)) {
        p.onSelectPlot(plot);
        return;
      }
    }
    p.onSelectPlot(null);
  };

  return <canvas ref={canvasRef} style={{ position: 'absolute', inset: 0, cursor: 'crosshair' }} onClick={handleClick} />;
}

function pointInPolygon(x: number, y: number, poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}
