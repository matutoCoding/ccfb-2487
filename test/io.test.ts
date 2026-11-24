import { describe, it, expect } from 'vitest';
import { writeTiledTiff } from '../src/io/tiff-writer';
import { fromArrayBuffer } from 'geotiff';
import { buildPyramidMeta, downsampleBox, sliceTiles } from '../src/io/pyramid';
import { BAND_COUNT } from '../src/types';

describe('TIFF 写出/读回往返', () => {
  it('geotiff.js 能读回写入的五波段 tiled 数据', async () => {
    const W = 300;
    const H = 200;
    const TS = 128;
    const data = new Uint16Array(W * H * BAND_COUNT);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        for (let b = 0; b < BAND_COUNT; b++) {
          data[(y * W + x) * BAND_COUNT + b] = (x * 7 + y * 13 + b * 1009) % 60000;
        }
      }
    }
    const buf = writeTiledTiff({ width: W, height: H, tileSize: TS, bands: BAND_COUNT, bandNames: ['B', 'G', 'R', 'RE', 'NIR'], data });
    const tiff = await fromArrayBuffer(buf);
    const image = await tiff.getImage();
    expect(image.getWidth()).toBe(W);
    expect(image.getHeight()).toBe(H);
    expect(image.getSamplesPerPixel()).toBe(5);
    // PlanarConfig=2: 每波段一个 TypedArray
    const planes = (await image.readRasters({ interleave: false })) as unknown as Uint16Array[];
    expect(planes).toHaveLength(5);
    const samples: [number, number][] = [
      [0, 0], [1, 1], [127, 127], [128, 128], [299, 199], [150, 77],
    ];
    for (const [x, y] of samples) {
      for (let b = 0; b < BAND_COUNT; b++) {
        expect(planes[b][y * W + x]).toBe(data[(y * W + x) * BAND_COUNT + b]);
      }
    }
  });
});

describe('金字塔', () => {
  it('层级数与维度', () => {
    const meta = buildPyramidMeta(2048, 1024, 256);
    expect(meta.levels.map((l) => [l.width, l.height])).toEqual([
      [2048, 1024], [1024, 512], [512, 256], [256, 128],
    ]);
    expect(meta.levels[0].tilesX).toBe(8);
    expect(meta.levels[0].tilesY).toBe(4);
  });

  it('box 降采样 = 2x2 均值 (奇数宽边缘正确)', () => {
    // 2x2 -> 1x1
    const src = new Uint16Array(4 * BAND_COUNT);
    for (let i = 0; i < 4; i++) for (let b = 0; b < BAND_COUNT; b++) src[i * BAND_COUNT + b] = (i + 1) * 10 + b;
    const dst = downsampleBox(src, 2, 2);
    expect(dst).toHaveLength(BAND_COUNT);
    for (let b = 0; b < BAND_COUNT; b++) {
      const mean = [10, 20, 30, 40].reduce((a, v) => a + v + b, 0) / 4;
      expect(dst[b]).toBe(Math.round(mean));
    }
    // 3x1 -> 2x1, 边缘列单像素
    const src2 = new Uint16Array(3 * 1 * BAND_COUNT);
    for (let x = 0; x < 3; x++) for (let b = 0; b < BAND_COUNT; b++) src2[x * BAND_COUNT + b] = x * 100 + b;
    const dst2 = downsampleBox(src2, 3, 1);
    expect(dst2).toHaveLength(2 * BAND_COUNT);
    expect(dst2[BAND_COUNT]).toBe(src2[2 * BAND_COUNT]); // 边缘单列原样
  });

  it('切片数量与边缘补零', () => {
    const full = new Uint16Array(300 * 200 * BAND_COUNT).fill(7);
    const { tiles, tilesX, tilesY } = sliceTiles(full, 300, 200, 128);
    expect(tilesX).toBe(3);
    expect(tilesY).toBe(2);
    expect(tiles).toHaveLength(6);
    // 边缘 tile 越界部分为 0, 有效部分为 7
    const edge = tiles[5]; // 右下
    expect(edge[0]).toBe(7);
    expect(edge[(127 * 128 + 127) * BAND_COUNT]).toBe(0);
  });
});
