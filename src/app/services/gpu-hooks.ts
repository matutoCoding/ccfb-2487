import { useCallback, useEffect, useRef, useState } from 'react';
import { getCapabilities, hasWebGPU, resetGpuForTest, type GpuCapabilities } from '../../gpu/device';
import { RasterService } from '../../io/raster-service';
import { useAppStore } from '../../state/store';
import type { Calibration, FlightImage, Plot, PlotStats } from '../../types';
import type { CompiledExpression } from '../../core/expression';

let singleton: { caps: GpuCapabilities; services: Map<string, RasterService> } | null = null;

export function useGpu() {
  const [caps, setCaps] = useState<GpuCapabilities | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);
  const gpuReady = useAppStore((s) => s.gpuReady);
  const setGpuReady = useAppStore((s) => s.setGpuReady);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const ok = await hasWebGPU();
      if (!ok) {
        if (!cancelled) {
          setError('浏览器不支持 WebGPU, 请使用最新版 Chrome/Edge (120+)');
          setChecking(false);
        }
        return;
      }
      try {
        // 离屏初始化 canvas
        const c = document.createElement('canvas');
        c.width = 4;
        c.height = 4;
        const capabilities = await getCapabilities(c);
        if (!cancelled) {
          singleton = { caps: capabilities, services: new Map() };
          setCaps(capabilities);
          setGpuReady(true);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setChecking(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [setGpuReady]);

  return { caps, error, checking, gpuReady };
}

export function getGpuSingleton(): { caps: GpuCapabilities; services: Map<string, RasterService> } | null {
  return singleton;
}

export function disposeGpuSingleton(): void {
  if (singleton) {
    for (const s of singleton.services.values()) s.dispose();
    singleton.services.clear();
  }
  resetGpuForTest();
  singleton = null;
}

/** 获取 (或惰性创建) 某影像的 RasterService, 自动套用缓存预算 */
export function useRasterService(image: FlightImage | null) {
  const settings = useAppStore((s) => s.settings);
  const [service, setService] = useState<RasterService | null>(null);
  const lastId = useRef<string | null>(null);

  useEffect(() => {
    if (!image || !singleton) {
      setService(null);
      return;
    }
    if (lastId.current === image.id && singleton.services.has(image.id)) {
      setService(singleton.services.get(image.id)!);
      return;
    }
    // 切换影像: 释放超出预算数量的旧 service (保留最近 2 个, 内存由 LRU 硬预算兜底)
    let existing = singleton.services.get(image.id);
    if (!existing) {
      existing = new RasterService(
        singleton.caps,
        image,
        settings.ramCacheBudgetMB * 1024 * 1024,
        settings.gpuMemoryBudgetMB * 1024 * 1024,
      );
      singleton.services.set(image.id, existing);
    }
    if (singleton.services.size > 2) {
      const oldest = singleton.services.keys().next().value as string;
      if (oldest !== image.id) {
        singleton.services.get(oldest)?.dispose();
        singleton.services.delete(oldest);
      }
    }
    lastId.current = image.id;
    setService(existing);
  }, [image, settings.ramCacheBudgetMB, settings.gpuMemoryBudgetMB]);

  return service;
}

export interface StatsRunHandle {
  run: (
    plots: Plot[],
    calibration: Calibration,
    expr: CompiledExpression,
    indexName: string,
  ) => Promise<PlotStats[] | null>;
}

export function useStatsRunner(service: RasterService | null) {
  const settings = useAppStore((s) => s.settings);
  const setBusy = useAppStore((s) => s.setBusy);

  const run = useCallback(
    async (plots: Plot[], calibration: Calibration, expr: CompiledExpression, indexName: string) => {
      if (!service) return null;
      setBusy(true, 'GPU 小区统计计算中…', 0.1);
      try {
        const t0 = performance.now();
        const result = await service.computeStats(
          plots,
          calibration,
          settings.mask,
          settings.flagCloudShadowFraction,
          expr,
          service.image.tileSize > 0 ? (useAppStore.getState().gridConfig?.insetPx ?? 4) : 4,
          indexName,
        );
        const ms = performance.now() - t0;
        setBusy(true, `GPU 统计完成 (${ms.toFixed(0)} ms)`, 1);
        return result;
      } finally {
        setTimeout(() => setBusy(false), 400);
      }
    },
    [service, settings.mask, settings.flagCloudShadowFraction, setBusy],
  );

  return { run };
}
