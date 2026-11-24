import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type {
  Calibration,
  DesignRow,
  FlightImage,
  Experiment,
  GcpPoint,
  Plot,
  PlotGridConfig,
  PlotStats,
} from '../types';

const DB_NAME = 'breeding-phenotype-db';
const DB_VERSION = 1;

interface BpDB extends DBSchema {
  experiments: { key: string; value: Experiment };
  images: { key: string; value: FlightImage; indexes: { byExperiment: string } };
  calibrations: { key: string; value: Calibration; indexes: { byImage: string } };
  grids: { key: string; value: { experimentId: string; config: PlotGridConfig; plots: Plot[] } };
  designs: { key: string; value: DesignRow; indexes: { byExperiment: string } };
  tiles: { key: string; value: { data: Uint16Array }; indexes: { byImage: string } };
  stats: { key: string; value: PlotStats & { key: string }; indexes: { byImage: string; byPlot: string } };
  gcps: { key: string; value: GcpPoint & { imageId: string }; indexes: { byImage: string } };
  kv: { key: string; value: unknown };
}

let dbPromise: Promise<IDBPDatabase<BpDB>> | null = null;

export function getDB(): Promise<IDBPDatabase<BpDB>> {
  if (!dbPromise) {
    dbPromise = openDB<BpDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        db.createObjectStore('experiments', { keyPath: 'id' });
        const img = db.createObjectStore('images', { keyPath: 'id' });
        img.createIndex('byExperiment', 'experimentId');
        const cal = db.createObjectStore('calibrations', { keyPath: 'id' });
        cal.createIndex('byImage', 'imageId');
        db.createObjectStore('grids', { keyPath: 'experimentId' });
        const des = db.createObjectStore('designs', { keyPath: 'experimentId' });
        des.createIndex('byExperiment', 'experimentId');
        const tile = db.createObjectStore('tiles', { keyPath: 'key' });
        tile.createIndex('byImage', 'imageId');
        const st = db.createObjectStore('stats', { keyPath: 'key' });
        st.createIndex('byImage', 'imageId');
        st.createIndex('byPlot', 'plotId');
        const gcp = db.createObjectStore('gcps', { keyPath: 'id' });
        gcp.createIndex('byImage', 'imageId');
        db.createObjectStore('kv');
      },
    });
  }
  return dbPromise;
}

export function tileKey(imageId: string, level: number, ty: number, tx: number): string {
  return `${imageId}/L${level}/Y${ty}/X${tx}`;
}

export interface TileRecord {
  key: string;
  imageId: string;
  level: number;
  tx: number;
  ty: number;
  data: Uint16Array;
}

const TILE_CHUNK = 64;

/** 分块事务批量写切片, 避免单事务过大导致 IDB 超时/失败 */
export async function putTiles(records: TileRecord[], onProgress?: (done: number, total: number) => void): Promise<void> {
  const db = await getDB();
  for (let i = 0; i < records.length; i += TILE_CHUNK) {
    const chunk = records.slice(i, i + TILE_CHUNK);
    const tx = db.transaction('tiles', 'readwrite');
    await Promise.all(chunk.map((r) => tx.store.put(r)));
    await tx.done;
    onProgress?.(Math.min(i + TILE_CHUNK, records.length), records.length);
  }
}

export async function getTile(imageId: string, level: number, ty: number, tx: number): Promise<Uint16Array | undefined> {
  const db = await getDB();
  const rec = await db.get('tiles', tileKey(imageId, level, ty, tx));
  return rec?.data;
}

export async function deleteImageTiles(imageId: string): Promise<void> {
  const db = await getDB();
  const tx = db.transaction('tiles', 'readwrite');
  const idx = tx.store.index('byImage');
  let cursor = await idx.openCursor(IDBKeyRange.only(imageId));
  while (cursor) {
    await cursor.delete();
    cursor = await cursor.continue();
  }
  await tx.done;
}

export async function deleteImageStats(imageId: string): Promise<void> {
  const db = await getDB();
  const tx = db.transaction('stats', 'readwrite');
  const idx = tx.store.index('byImage');
  let cursor = await idx.openCursor(IDBKeyRange.only(imageId));
  while (cursor) {
    await cursor.delete();
    cursor = await cursor.continue();
  }
  await tx.done;
}

export async function clearAll(): Promise<void> {
  const db = await getDB();
  const stores = ['experiments', 'images', 'calibrations', 'grids', 'designs', 'tiles', 'stats', 'gcps', 'kv'] as const;
  const tx = db.transaction(stores, 'readwrite');
  await Promise.all(stores.map((s) => tx.objectStore(s).clear()));
  await tx.done;
}

export async function estimateStorage(): Promise<{ usage: number; quota: number }> {
  if (navigator.storage?.estimate) {
    const est = await navigator.storage.estimate();
    return { usage: est.usage ?? 0, quota: est.quota ?? 0 };
  }
  return { usage: 0, quota: 0 };
}

// ---- 元数据便捷方法 ----
export async function putExperiment(e: Experiment): Promise<void> {
  const db = await getDB();
  await db.put('experiments', e);
}
export async function listExperiments(): Promise<Experiment[]> {
  const db = await getDB();
  const all = await db.getAll('experiments');
  return all.sort((a, b) => b.createdAt - a.createdAt);
}
export async function getExperiment(id: string): Promise<Experiment | undefined> {
  return (await getDB()).get('experiments', id);
}
export async function deleteExperiment(id: string): Promise<void> {
  const db = await getDB();
  const images = await db.getAllFromIndex('images', 'byExperiment', id);
  for (const img of images) {
    await deleteImageTiles(img.id);
    await deleteImageStats(img.id);
  }
  const tx = db.transaction(['experiments', 'images', 'calibrations', 'grids', 'designs', 'stats', 'gcps'], 'readwrite');
  await Promise.all([
    tx.objectStore('experiments').delete(id),
    tx.objectStore('grids').delete(id),
    tx.objectStore('designs').delete(id),
  ]);
  for (const img of images) {
    await tx.objectStore('images').delete(img.id);
    await tx.objectStore('calibrations').delete(img.calibrationId ?? '');
  }
  await tx.done;
}

export async function putImage(img: FlightImage): Promise<void> {
  await (await getDB()).put('images', img);
}
export async function getImage(id: string): Promise<FlightImage | undefined> {
  return (await getDB()).get('images', id);
}
export async function listImages(experimentId: string): Promise<FlightImage[]> {
  const all = await (await getDB()).getAllFromIndex('images', 'byExperiment', experimentId);
  return all.sort((a, b) => a.date.localeCompare(b.date));
}

export async function putCalibration(c: Calibration): Promise<void> {
  await (await getDB()).put('calibrations', c);
}
export async function getCalibrationByImage(imageId: string): Promise<Calibration | undefined> {
  return (await getDB()).getFromIndex('calibrations', 'byImage', imageId);
}

export async function saveGrid(experimentId: string, config: PlotGridConfig, plots: Plot[]): Promise<void> {
  await (await getDB()).put('grids', { experimentId, config, plots });
}
export async function loadGrid(experimentId: string): Promise<{ config: PlotGridConfig; plots: Plot[] } | undefined> {
  const rec = await (await getDB()).get('grids', experimentId);
  return rec ? { config: rec.config, plots: rec.plots } : undefined;
}

export async function saveDesigns(rows: DesignRow[]): Promise<void> {
  if (rows.length === 0) return;
  const db = await getDB();
  const tx = db.transaction('designs', 'readwrite');
  await Promise.all(rows.map((r) => tx.store.put(r)));
  await tx.done;
}
export async function listDesigns(experimentId: string): Promise<DesignRow[]> {
  return (await getDB()).getAllFromIndex('designs', 'byExperiment', experimentId);
}

export async function putStatsBatch(stats: PlotStats[]): Promise<void> {
  const db = await getDB();
  const tx = db.transaction('stats', 'readwrite');
  await Promise.all(
    stats.map((s) =>
      tx.store.put({ ...s, key: `${s.imageId}/${s.indexName}/${s.plotId}` }),
    ),
  );
  await tx.done;
}
export async function getStats(imageId: string, indexName: string): Promise<PlotStats[]> {
  const db = await getDB();
  const all = await db.getAllFromIndex('stats', 'byImage', imageId);
  return all.filter((s) => s.indexName === indexName);
}

export async function saveGcps(imageId: string, gcps: GcpPoint[]): Promise<void> {
  const db = await getDB();
  const tx = db.transaction('gcps', 'readwrite');
  const idx = tx.store.index('byImage');
  let cursor = await idx.openCursor(IDBKeyRange.only(imageId));
  while (cursor) {
    await cursor.delete();
    cursor = await cursor.continue();
  }
  await Promise.all(gcps.map((g) => tx.store.put({ ...g, imageId })));
  await tx.done;
}
export async function listGcps(imageId: string): Promise<(GcpPoint & { imageId: string })[]> {
  return (await getDB()).getAllFromIndex('gcps', 'byImage', imageId);
}

export async function kvGet<T>(key: string): Promise<T | undefined> {
  return (await getDB()).get('kv', key) as Promise<T | undefined>;
}
export async function kvSet(key: string, value: unknown): Promise<void> {
  await (await getDB()).put('kv', value, key);
}
