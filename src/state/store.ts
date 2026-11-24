import { create } from 'zustand';
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type BandExpression,
  type Experiment,
  type FlightImage,
  type PlotGridConfig,
  type Plot,
} from '../types';
import { BUILTIN_EXPRESSIONS } from '../types';
import { kvGet, kvSet } from '../db/idb';

interface AppState {
  experiments: Experiment[];
  currentExperimentId: string | null;
  images: FlightImage[];
  currentImageId: string | null;
  gridConfig: PlotGridConfig | null;
  plots: Plot[];
  expressions: BandExpression[];
  currentExprName: string;
  settings: AppSettings;
  gpuReady: boolean;
  busy: { active: boolean; message: string; pct: number };

  setExperiments: (e: Experiment[]) => void;
  setCurrentExperiment: (id: string | null) => void;
  setImages: (i: FlightImage[]) => void;
  setCurrentImage: (id: string | null) => void;
  setGrid: (cfg: PlotGridConfig, plots: Plot[]) => void;
  setExpressions: (e: BandExpression[]) => void;
  setCurrentExpr: (name: string) => void;
  setSettings: (s: AppSettings) => void;
  setGpuReady: (v: boolean) => void;
  setBusy: (active: boolean, message?: string, pct?: number) => void;
  hydrate: () => Promise<void>;
}

const DEFAULT_GRID: PlotGridConfig = {
  rows: 16,
  cols: 20,
  plotW: 72,
  plotH: 48,
  alleyX: 14,
  alleyY: 10,
  originX: 40,
  originY: 40,
  angleDeg: 0,
  insetPx: 6,
  rowOffsets: {},
  colOffsets: {},
};

export const useAppStore = create<AppState>((set, get) => ({
  experiments: [],
  currentExperimentId: null,
  images: [],
  currentImageId: null,
  gridConfig: DEFAULT_GRID,
  plots: [],
  expressions: [...BUILTIN_EXPRESSIONS],
  currentExprName: 'NDVI',
  settings: { ...DEFAULT_SETTINGS, mask: { ...DEFAULT_SETTINGS.mask } },
  gpuReady: false,
  busy: { active: false, message: '', pct: 0 },

  setExperiments: (experiments) => set({ experiments }),
  setCurrentExperiment: (currentExperimentId) => set({ currentExperimentId }),
  setImages: (images) => set({ images }),
  setCurrentImage: (currentImageId) => set({ currentImageId }),
  setGrid: (gridConfig, plots) => set({ gridConfig, plots }),
  setExpressions: (expressions) => {
    set({ expressions });
    void kvSet('expressions', expressions);
  },
  setCurrentExpr: (currentExprName) => {
    set({ currentExprName });
    void kvSet('currentExprName', currentExprName);
  },
  setSettings: (settings) => {
    set({ settings });
    void kvSet('settings', settings);
  },
  setGpuReady: (gpuReady) => set({ gpuReady }),
  setBusy: (active, message = '', pct = 0) => set({ busy: { active, message, pct } }),

  hydrate: async () => {
    const [settings, expressions, currentExprName] = await Promise.all([
      kvGet<AppSettings>('settings'),
      kvGet<BandExpression[]>('expressions'),
      kvGet<string>('currentExprName'),
    ]);
    set({
      settings: settings ?? { ...DEFAULT_SETTINGS, mask: { ...DEFAULT_SETTINGS.mask } },
      expressions: expressions ?? [...BUILTIN_EXPRESSIONS],
      currentExprName: currentExprName ?? 'NDVI',
      gridConfig: get().gridConfig ?? DEFAULT_GRID,
    });
  },
}));

export { DEFAULT_GRID };
