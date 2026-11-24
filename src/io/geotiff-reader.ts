import { fromArrayBuffer, type GeoTIFF, type GeoTIFFImage } from 'geotiff';
import { BAND_COUNT, BAND_NAMES, type BandName } from '../types';

export interface GeoTiffInfo {
  width: number;
  height: number;
  bands: number;
  tileWidth: number;
  tileHeight: number;
  bandNames: BandName[];
  littleEndian: boolean;
}

/** 读取 GeoTIFF 基础信息并校验为五波段 uint16 正射影像 */
export async function readGeoTiffInfo(buffer: ArrayBuffer): Promise<{ info: GeoTiffInfo; tiff: GeoTIFF; image: GeoTIFFImage }> {
  const tiff = await fromArrayBuffer(buffer);
  const image = await tiff.getImage();
  const fd = image.getFileDirectory();
  const width = image.getWidth();
  const height = image.getHeight();
  const bands = image.getSamplesPerPixel();
  if (bands !== BAND_COUNT) {
    throw new Error(`需要五波段 (B/G/R/RE/NIR) 影像, 实际波段数=${bands}`);
  }
  if (fd.BitsPerSample && fd.BitsPerSample.some((b: number) => b !== 16)) {
    throw new Error('仅支持 uint16 (16-bit) 影像');
  }
  const tileWidth = fd.TileWidth || width;
  const tileHeight = fd.TileLength || height;
  // GDAL 波段名
  let bandNames: BandName[] = [...BAND_NAMES];
  const desc: string = fd.ImageDescription ?? '';
  const matched = [...desc.matchAll(/Band_\d+[^>]*>([A-Za-z]+)</g)].map((m) => m[1]);
  if (matched.length === BAND_COUNT && matched.every((m) => (BAND_NAMES as readonly string[]).includes(m))) {
    bandNames = matched as BandName[];
  }
  return {
    info: {
      width,
      height,
      bands,
      tileWidth,
      tileHeight,
      bandNames,
      littleEndian: fd.isLittleEndian !== false,
    },
    tiff,
    image,
  };
}

/**
 * 分块读取整幅影像为平面存储 uint16 (bands * W * H)。
 * 大图按 block 窗口逐块读, 避免 geotiff.js 一次性分配全部中间缓冲。
 */
export async function readFullRasterPlanar(
  image: GeoTIFFImage,
  info: GeoTiffInfo,
  onProgress?: (pct: number) => void,
): Promise<Uint16Array> {
  const { width, height, bands, tileWidth, tileHeight } = info;
  const out = new Uint16Array(bands * width * height);
  const blockW = Math.max(tileWidth, 512);
  const blockH = Math.max(tileHeight, 512);
  let done = 0;
  const total = Math.ceil(width / blockW) * Math.ceil(height / blockH);
  for (let y0 = 0; y0 < height; y0 += blockH) {
    const y1 = Math.min(height, y0 + blockH);
    for (let x0 = 0; x0 < width; x0 += blockW) {
      const x1 = Math.min(width, x0 + blockW);
      // PlanarConfig=2: interleave=false 返回每波段一个 TypedArray
      const result = (await image.readRasters({
        window: [x0, y0, x1, y1],
        interleave: false,
        pool: undefined,
      })) as unknown as Uint16Array[];
      const bw = x1 - x0;
      const bh = y1 - y0;
      for (let b = 0; b < bands; b++) {
        const bandBlock = result[b];
        const planeBase = b * width * height;
        for (let y = 0; y < bh; y++) {
          const srcRow = y * bw;
          const dstRow = (y0 + y) * width + x0;
          out.set(bandBlock.subarray(srcRow, srcRow + bw), planeBase + dstRow);
        }
      }
      done++;
      onProgress?.(done / total);
    }
  }
  return out;
}
