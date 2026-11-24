/**
 * 最小化 tiled TIFF 写出器 (Little Endian)
 * 支持: uint16, 5 波段, 平面分离存储 (PlanarConfiguration=2, GDAL 多波段标准布局),
 * 分块存储, GDAL 波段名元数据。
 * 小图写 Classic TIFF; 单 IFD 偏移超 4GB 时写 BigTIFF。
 * 输出可被 geotiff.js / GDAL / QGIS 直接读取。
 */

const TAG = {
  ImageWidth: 256,
  ImageLength: 257,
  BitsPerSample: 258,
  Compression: 259,
  Photometric: 262,
  ImageDescription: 270,
  SamplesPerPixel: 277,
  TileWidth: 322,
  TileLength: 323,
  TileOffsets: 324,
  TileByteCounts: 325,
  PlanarConfig: 284,
  SampleFormat: 339,
} as const;

const TYPE_SIZE: Record<number, number> = { 1: 1, 3: 2, 4: 4, 5: 8 };
const TYPE_BIG_SIZE: Record<number, number> = { 1: 1, 3: 2, 4: 4, 5: 8, 16: 8 };

interface IfdEntry {
  tag: number;
  type: number;
  count: number;
  value: number | number[] | string;
}

export interface WriteTiffOptions {
  width: number;
  height: number;
  tileSize: number;
  bands: number;
  bandNames?: string[];
  /** 像素交错输入: data[y*width*bands + x*bands + b], uint16; 写出时转平面分离 */
  data: Uint16Array;
}

export function writeTiledTiff(opts: WriteTiffOptions): ArrayBuffer {
  const { width, height, tileSize, bands, data, bandNames } = opts;
  const tilesX = Math.ceil(width / tileSize);
  const tilesY = Math.ceil(height / tileSize);
  const spatialTiles = tilesX * tilesY;
  // PlanarConfig=2: 每波段独立 tile, 排列顺序 = band 主序, 空间次序序
  const tileCount = spatialTiles * bands;
  const tileBytes = tileSize * tileSize * 2;
  const useBig = tileCount * tileBytes > 0xffffffff - 65536;

  // 1) 切片数据: 每 tile 单波段 (边缘用 0 填充)
  const tiles: Uint16Array[] = [];
  for (let b = 0; b < bands; b++) {
    for (let ty = 0; ty < tilesY; ty++) {
      for (let tx = 0; tx < tilesX; tx++) {
        const tile = new Uint16Array(tileSize * tileSize);
        for (let y = 0; y < tileSize; y++) {
          const sy = ty * tileSize + y;
          if (sy >= height) continue;
          for (let x = 0; x < tileSize; x++) {
            const sx = tx * tileSize + x;
            if (sx >= width) continue;
            tile[y * tileSize + x] = data[(sy * width + sx) * bands + b];
          }
        }
        tiles.push(tile);
      }
    }
  }

  // 2) GDAL 波段名元数据
  let desc = '';
  if (bandNames && bandNames.length === bands) {
    const items = bandNames.map((n, i) => `<Item name="Band_${i + 1}" sampleFormat="UInt16">${n}</Item>`).join('');
    desc = `<GDALMetadata>${items}</GDALMetadata>`;
  }

  const entries: IfdEntry[] = [
    { tag: TAG.ImageWidth, type: width > 65535 ? 4 : 3, count: 1, value: width },
    { tag: TAG.ImageLength, type: height > 65535 ? 4 : 3, count: 1, value: height },
    { tag: TAG.BitsPerSample, type: 3, count: bands, value: new Array(bands).fill(16) },
    { tag: TAG.Compression, type: 3, count: 1, value: 1 },
    { tag: TAG.Photometric, type: 3, count: 1, value: 1 },
    { tag: TAG.SamplesPerPixel, type: 3, count: 1, value: bands },
    { tag: TAG.PlanarConfig, type: 3, count: 1, value: 2 }, // 平面分离
    { tag: TAG.TileWidth, type: 3, count: 1, value: tileSize },
    { tag: TAG.TileLength, type: 3, count: 1, value: tileSize },
    { tag: TAG.TileOffsets, type: useBig ? 16 : 4, count: tileCount, value: new Array(tileCount).fill(0) },
    { tag: TAG.TileByteCounts, type: useBig ? 16 : 4, count: tileCount, value: new Array(tileCount).fill(tileBytes) },
    { tag: TAG.SampleFormat, type: 3, count: bands, value: new Array(bands).fill(1) },
  ];
  if (desc) entries.push({ tag: TAG.ImageDescription, type: 2, count: desc.length + 1, value: desc });
  entries.sort((a, b) => a.tag - b.tag);

  return useBig ? buildBigTiff(entries, tiles, tileBytes) : buildClassicTiff(entries, tiles, tileBytes);
}

function buildClassicTiff(entries: IfdEntry[], tiles: Uint16Array[], tileBytes: number): ArrayBuffer {
  const headerSize = 8;
  const ifdSize = 2 + entries.length * 12 + 4;
  let cursor = headerSize + ifdSize;
  const externals: { entry: IfdEntry; offset: number; bytes: Uint8Array }[] = [];
  for (const e of entries) {
    const inlineCap = 4;
    const total = TYPE_SIZE[e.type] * e.count;
    // TileOffsets 无论大小一律外部存储, 便于切片写完后回填
    if (e.type === 2 || total > inlineCap || e.tag === TAG.TileOffsets) {
      const bytes = encodeEntryValue(e, false);
      externals.push({ entry: e, offset: cursor, bytes });
      cursor += bytes.byteLength;
      if (cursor % 2) cursor++;
    }
  }
  const ifdOffset = headerSize;
  const tileDataStart = cursor;
  const totalSize = tileDataStart + tiles.length * tileBytes;
  const buf = new ArrayBuffer(totalSize);
  const dv = new DataView(buf);
  dv.setUint16(0, 0x4949, true); // II
  dv.setUint16(2, 42, true);
  dv.setUint32(4, ifdOffset, true);

  let p = ifdOffset;
  dv.setUint16(p, entries.length, true);
  p += 2;
  for (const e of entries) {
    dv.setUint16(p, e.tag, true);
    dv.setUint16(p + 2, e.type, true);
    dv.setUint32(p + 4, e.count, true);
    const ext = externals.find((x) => x.entry === e);
    if (ext) {
      dv.setUint32(p + 8, ext.offset, true);
    } else {
      writeInline(dv, p + 8, e, false);
    }
    p += 12;
  }
  dv.setUint32(p, 0, true);

  for (const x of externals) new Uint8Array(buf, x.offset, x.bytes.byteLength).set(x.bytes);

  const offEntry = entries.find((e) => e.tag === TAG.TileOffsets)!;
  let tp = tileDataStart;
  for (let i = 0; i < tiles.length; i++) {
    new Uint8Array(buf, tp, tileBytes).set(new Uint8Array(tiles[i].buffer, tiles[i].byteOffset, tileBytes));
    (offEntry.value as number[])[i] = tp;
    tp += tileBytes;
  }
  const offExt = externals.find((x) => x.entry === offEntry)!;
  for (let i = 0; i < tiles.length; i++) dv.setUint32(offExt.offset + i * 4, (offEntry.value as number[])[i], true);
  return buf;
}

function buildBigTiff(entries: IfdEntry[], tiles: Uint16Array[], tileBytes: number): ArrayBuffer {
  const headerSize = 16;
  const ifdSize = 8 + entries.length * 20 + 8;
  let cursor = headerSize + ifdSize;
  const externals: { entry: IfdEntry; offset: number; bytes: Uint8Array }[] = [];
  for (const e of entries) {
    const total = TYPE_BIG_SIZE[e.type] * e.count;
    if (e.type === 2 || total > 8 || e.tag === TAG.TileOffsets) {
      const bytes = encodeEntryValue(e, true);
      externals.push({ entry: e, offset: cursor, bytes });
      cursor += bytes.byteLength;
      if (cursor % 2) cursor++;
    }
  }
  const ifdOffset = headerSize;
  const tileDataStart = cursor;
  const totalSize = tileDataStart + tiles.length * tileBytes;
  const buf = new ArrayBuffer(totalSize);
  const dv = new DataView(buf);
  dv.setUint16(0, 0x4949, true);
  dv.setUint16(2, 43, true);
  dv.setUint16(4, 8, true);
  dv.setUint16(6, 0, true);
  dv.setBigUint64(8, BigInt(ifdOffset), true);
  dv.setBigUint64(12, 0n, true);

  let p = ifdOffset;
  dv.setBigUint64(p, BigInt(entries.length), true);
  p += 8;
  for (const e of entries) {
    dv.setUint16(p, e.tag, true);
    dv.setUint16(p + 2, e.type, true);
    dv.setBigUint64(p + 4, BigInt(e.count), true);
    const ext = externals.find((x) => x.entry === e);
    if (ext) {
      dv.setBigUint64(p + 12, BigInt(ext.offset), true);
    } else {
      writeInline(dv, p + 12, e, true);
    }
    p += 20;
  }
  dv.setBigUint64(p, 0n, true);

  for (const x of externals) new Uint8Array(buf, x.offset, x.bytes.byteLength).set(x.bytes);

  const offEntry = entries.find((e) => e.tag === TAG.TileOffsets)!;
  const offExt = externals.find((x) => x.entry === offEntry)!;
  let tp = tileDataStart;
  for (let i = 0; i < tiles.length; i++) {
    new Uint8Array(buf, tp, tileBytes).set(new Uint8Array(tiles[i].buffer, tiles[i].byteOffset, tileBytes));
    dv.setBigUint64(offExt.offset + i * 8, BigInt(tp), true);
    tp += tileBytes;
  }
  return buf;
}

function encodeEntryValue(e: IfdEntry, big: boolean): Uint8Array {
  if (e.type === 2) {
    const s = (e.value as string) + '\0';
    return new TextEncoder().encode(s);
  }
  const arr = (Array.isArray(e.value) ? e.value : [e.value]) as number[];
  const unit = big ? TYPE_BIG_SIZE[e.type] : TYPE_SIZE[e.type];
  const bytes = new Uint8Array(arr.length * unit);
  const dv = new DataView(bytes.buffer);
  for (let i = 0; i < arr.length; i++) {
    if (e.type === 3) dv.setUint16(i * 2, arr[i], true);
    else if (e.type === 4) dv.setUint32(i * 4, arr[i], true);
    else if (e.type === 16) dv.setBigUint64(i * 8, BigInt(arr[i]), true);
  }
  return bytes;
}

function writeInline(dv: DataView, offset: number, e: IfdEntry, big: boolean): void {
  const v = (Array.isArray(e.value) ? e.value[0] : e.value) as number;
  if (big) {
    if (e.type === 16) dv.setBigUint64(offset, BigInt(v), true);
    else if (e.type === 4) dv.setUint32(offset, v, true);
    else dv.setUint16(offset, v, true);
    return;
  }
  if (e.type === 3) dv.setUint16(offset, v, true);
  else dv.setUint32(offset, v, true);
}
