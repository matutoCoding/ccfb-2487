import { describe, it, expect } from 'vitest';
import { generateSyntheticScene } from '../src/io/synthetic';

describe('合成测试影像', () => {
  const scene = generateSyntheticScene({ width: 512, height: 512, tileSize: 128, seed: 7 });

  it('尺寸与定标板位置', () => {
    expect(scene.data).toHaveLength(512 * 512 * 5);
    expect(scene.panelRect.x).toBeGreaterThan(0);
    expect(scene.panelRect.y).toBeGreaterThan(0);
  });

  it('定标板四档灰阶 DN 单调递增 (每波段)', () => {
    const { x, y, w } = scene.panelRect;
    const centers = [0.125, 0.375, 0.625, 0.875].map((f) => x + Math.floor(f * w));
    const dns = centers.map((cx) => {
      const off = (y * 512 + cx) * 5;
      return [0, 1, 2, 3, 4].map((b) => scene.data[off + b]);
    });
    for (let b = 0; b < 5; b++) {
      for (let i = 1; i < 4; i++) expect(dns[i][b]).toBeGreaterThan(dns[i - 1][b]);
    }
  });

  it('云区比邻近非云区亮, 阴影区比周边暗', () => {
    const avgAt = (x: number, y: number) => {
      let s = 0;
      for (let b = 0; b < 5; b++) s += scene.data[(y * 512 + x) * 5 + b];
      return s / 5;
    };
    const cloudCenter = avgAt(Math.floor(scene.cloud.x), Math.floor(scene.cloud.y));
    const cloudOutside = avgAt(Math.floor(scene.cloud.x - scene.cloud.rx * 1.2), Math.floor(scene.cloud.y));
    expect(cloudCenter).toBeGreaterThan(cloudOutside);
    const shadowCenter = avgAt(Math.floor(scene.shadow.x), Math.floor(scene.shadow.y));
    const shadowOutside = avgAt(Math.floor(scene.shadow.x + scene.shadow.rx * 1.2), Math.floor(scene.shadow.y));
    expect(shadowCenter).toBeLessThan(shadowOutside);
  });

  it('不同生育期参数产生不同 NIR 水平', () => {
    const early = generateSyntheticScene({ width: 256, height: 256, growthStage: 0.1, seed: 7 });
    const late = generateSyntheticScene({ width: 256, height: 256, growthStage: 0.9, seed: 7 });
    // 在第一个小区的作物行 (y 偏移 2, rowPhase<4) 内取一行像素的 NIR 均值
    const x0 = early.plotOrigin.x + 4;
    const y = early.plotOrigin.y + 2;
    const nirMean = (scene: Uint16Array) => {
      let s = 0;
      for (let x = x0; x < x0 + 30; x++) s += scene[(y * 256 + x) * 5 + 4];
      return s / 30;
    };
    expect(nirMean(late.data)).toBeGreaterThan(nirMean(early.data));
  });

  it('同种子可复现', () => {
    const a = generateSyntheticScene({ width: 128, height: 128, seed: 123 });
    const b = generateSyntheticScene({ width: 128, height: 128, seed: 123 });
    expect(a.data.every((v, i) => v === b.data[i])).toBe(true);
  });
});
