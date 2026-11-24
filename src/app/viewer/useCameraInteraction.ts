import { useCallback, useEffect, useState } from 'react';
import { clampScale, screenToWorld, type Camera } from './camera';

/** 相机交互: 拖拽平移 + 滚轮缩放 (以光标为锚点) */
export function useCameraInteraction(initial: Camera, elRef: React.RefObject<HTMLElement>) {
  const [camera, setCamera] = useState<Camera>(initial);

  useEffect(() => {
    setCamera(initial);
    // 仅在切换影像 (initial 引用变化) 时重置
  }, [initial]);

  const onWheel = useCallback(
    (e: WheelEvent) => {
      e.preventDefault();
      const el = elRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      setCamera((cam) => {
        const factor = Math.exp(-e.deltaY * 0.0015);
        const newScale = clampScale(cam.scale * factor);
        const [wx, wy] = screenToWorld(cam, rect.width, rect.height, mx, my);
        return {
          scale: newScale,
          centerX: wx - (mx - rect.width / 2) / newScale,
          centerY: wy - (my - rect.height / 2) / newScale,
        };
      });
    },
    [elRef],
  );

  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    let last: { x: number; y: number } | null = null;

    const down = (e: PointerEvent) => {
      if (e.button !== 0 && e.button !== 1) return;
      last = { x: e.clientX, y: e.clientY };
      el.setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      if (!last) return;
      const dx = e.clientX - last.x;
      const dy = e.clientY - last.y;
      last = { x: e.clientX, y: e.clientY };
      setCamera((cam) => ({
        ...cam,
        centerX: cam.centerX - dx / cam.scale,
        centerY: cam.centerY - dy / cam.scale,
      }));
    };
    const up = (e: PointerEvent) => {
      last = null;
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {
        /* noop */
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
    };
  }, [elRef, onWheel]);

  return { camera, setCamera };
}
