import type { FlightImage } from '../types';
import { BAND_COUNT } from '../types';
import { readFullRasterPlanar, readGeoTiffInfo } from './geotiff-reader';
import { buildPyramidMeta, downsampleBox, sliceTiles, type PyramidMeta } from './pyramid';
import { putImage, putTiles, type TileRecord } from '../db/idb';
import { uid } from '../core/util';

export interface ImportResult {
  image: FlightImage;
  meta: PyramidMeta;
  tileCount: number;
  bytes: number;
}

/**
 * 导入管线:
 *  GeoTIFF 分块读 -> 平面 uint16 -> box 降采样建金字塔 -> 切片 -> 分块事务写 IDB
 * 全程 uint16 原始 DN, 定标系数独立存储、读取时应用。
 */
export async function importGeoTiff(
  buffer: ArrayBuffer,
  experimentId: string,
  date: string,
  name: string,
  gsd: number,
  opts: { tileSize?: number; onProgress?: (stage: string, pct: number) => void } = {},
): Promise<ImportResult> {
  const tileSize = opts.tileSize ?? 256;
  const onProgress = opts.onProgress ?? (() => {});

  onProgress('读取 GeoTIFF 信息', 0);
  const { info, image } = await readGeoTiffInfo(buffer);
  onProgress('分块读取栅格', 0.05);
  const level0 = await readFullRasterPlanar(image, info, (p) => onProgress('分块读取栅格', 0.05 + p * 0.35));

  const meta = buildPyramidMeta(info.width, info.height, tileSize);
  const records: TileRecord[] = [];
  let current = level0;
  let w = info.width;
  let h = info.height;
  let bytes = 0;

  for (const lvl of meta.levels) {
    onProgress(`构建金字塔 L${lvl.level}`, 0.4 + (lvl.level / meta.levels.length) * 0.45);
    const { tiles, tilesX, tilesY } = sliceTiles(current, w, h, tileSize);
    if (tilesX !== lvl.tilesX || tilesY !== lvl.tilesY) {
      throw new Error('金字塔切片维度不一致');
    }
    for (let ty = 0; ty < tilesY; ty++) {
      for (let tx = 0; tx < tilesX; tx++) {
        const data = tiles[ty * tilesX + tx];
        const key = `${uid('img')}/L${lvl.level}/Y${ty}/X${tx}`; // 占位, 下面替换 imageId
        records.push({ key, imageId: '', level: lvl.level, tx, ty, data });
        bytes += data.byteLength;
      }
    }
    if (lvl.level < meta.levels.length - 1) {
      const next = downsampleBox(current, w, h);
      current = next;
      w = Math.max(1, Math.ceil(w / 2));
      h = Math.max(1, Math.ceil(h / 2));
    }
  }

  const imageId = uid('img');
  for (const r of records) r.imageId = imageId;
  for (const r of records) r.key = `${imageId}/L${r.level}/Y${r.ty}/X${r.tx}`;

  onProgress('写入 IndexedDB', 0.85);
  await putTiles(records, (done, total) => onProgress('写入 IndexedDB', 0.85 + (done / total) * 0.15));

  const flight: FlightImage = {
    id: imageId,
    experimentId,
    date,
    name,
    width: info.width,
    height: info.height,
    tileSize,
    levels: meta.levels.length,
    dtype: 'uint16',
    bands: info.bandNames,
    gsd,
    importedAt: Date.now(),
  };
  await putImage(flight);
  return { image: flight, meta, tileCount: records.length, bytes };
}

/** 把已在内存中的合成影像直接走金字塔+入库流程 (测试影像免落盘 TIFF) */
export async function importPlanarRaster(
  data: Uint16Array,
  width: number,
  height: number,
  experimentId: string,
  date: string,
  name: string,
  gsd: number,
  tileSize = 256,
  onProgress?: (stage: string, pct: number) => void,
): Promise<ImportResult> {
  if (data.length !== width * height * BAND_COUNT) throw new Error('平面栅格尺寸不匹配');
  const meta = buildPyramidMeta(width, height, tileSize);
  const imageId = uid('img');
  const records: TileRecord[] = [];
  let current = data;
  let w = width;
  let h = height;
  let bytes = 0;
  for (const lvl of meta.levels) {
    onProgress?.(`构建金字塔 L${lvl.level}`, lvl.level / (meta.levels.length + 1));
    const { tiles, tilesX, tilesY } = sliceTiles(current, w, h, tileSize);
    for (let ty = 0; ty < tilesY; ty++) {
      for (let tx = 0; tx < tilesX; tx++) {
        const tileData = tiles[ty * tilesX + tx];
        records.push({ key: `${imageId}/L${lvl.level}/Y${ty}/X${tx}`, imageId, level: lvl.level, tx, ty, data: tileData });
        bytes += tileData.byteLength;
      }
    }
    if (lvl.level < meta.levels.length - 1) {
      current = downsampleBox(current, w, h);
      w = Math.max(1, Math.ceil(w / 2));
      h = Math.max(1, Math.ceil(h / 2));
    }
  }
  onProgress?.('写入 IndexedDB', 0.9);
  await putTiles(records);
  const flight: FlightImage = {
    id: imageId,
    experimentId,
    date,
    name,
    width,
    height,
    tileSize,
    levels: meta.levels.length,
    dtype: 'uint16',
    bands: ['B', 'G', 'R', 'RE', 'NIR'],
    gsd,
    importedAt: Date.now(),
  };
  await putImage(flight);
  return { image: flight, meta, tileCount: records.length, bytes };
}
