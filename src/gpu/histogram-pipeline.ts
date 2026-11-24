import type { GpuCapabilities } from './device';
import { writeGpuBuffer } from './device';
import { WGSL_SAFE_DIV, type CompiledExpression } from '../core/expression';
import { percentileFromHistogram } from '../core/stats';

/**
 * 全图指数直方图 (在指定金字塔层级采样), 1024 个等宽 bin,
 * 用于色带按直方图百分比拉伸。storage 缓冲 3 个, 满足设备下限。
 */
const BINS = 1024;
const RANGE_LO = -1;
const RANGE_HI = 1;

function fullWgsl(expr: CompiledExpression): string {
  return /* wgsl */ `
struct Uniforms {
  width: f32, height: f32, tileSize: f32, tileCount: f32,
  bins: f32, rangeLo: f32, rangeHi: f32, _pad: f32,
}
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var<storage, read> tiles: array<vec4i>;
@group(0) @binding(2) var img: texture_2d_array<u32>;
@group(0) @binding(3) var<storage, read_write> hist: array<atomic<u32>>;
@group(0) @binding(4) var<storage, read> calib: array<vec4f>;

fn gainOf(b: u32) -> f32 {
  if (b < 4u) { return calib[0][b]; }
  return calib[1].x;
}
fn offsetOf(b: u32) -> f32 {
  if (b < 4u) { return calib[2][b]; }
  return calib[3].x;
}

${WGSL_SAFE_DIV}

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let pixelIdx = gid.x;
  let ts = u32(u.tileSize);
  let perTile = ts * ts;
  if (pixelIdx >= u32(u.tileCount) * perTile) { return; }
  let tileIdx = pixelIdx / perTile;
  let local = pixelIdx % perTile;
  let tile = tiles[tileIdx];
  let lx = local % ts;
  let ly = local / ts;
  let gx = u32(tile.x) * ts + lx;
  let gy = u32(tile.y) * ts + ly;
  if (f32(gx) >= u.width || f32(gy) >= u.height) { return; }

  var refl: array<f32, 5>;
  for (var b = 0u; b < 5u; b++) {
    let dn = f32(textureLoad(img, vec2i(i32(lx), i32(ly)), b, 0).r);
    refl[b] = gainOf(b) * dn + offsetOf(b);
  }
  let b0 = refl[0]; let b1 = refl[1]; let b2 = refl[2]; let b3 = refl[3]; let b4 = refl[4];
  let v = ${expr.wgsl};
  if (v != v || abs(v) > 1e30) { return; }
  var bin = u32((v - u.rangeLo) / (u.rangeHi - u.rangeLo) * u.bins);
  bin = clamp(bin, 0u, u32(u.bins) - 1u);
  atomicAdd(&hist[bin], 1u);
}
`;
}

export interface HistTile {
  texture: GPUTexture;
  tx: number;
  ty: number;
  level: number;
  pixelCount: number;
}

export class HistogramPipeline {
  constructor(private caps: GpuCapabilities, private expr: CompiledExpression) {}

  async compute(
    tiles: HistTile[],
    levelWidth: number,
    levelHeight: number,
    tileSize: number,
    gains: number[],
    offsets: number[],
  ): Promise<{ hist: Uint32Array; lo: number; hi: number }> {
    const device = this.caps.device;
    const module = device.createShaderModule({ code: fullWgsl(this.expr) });
    const bindLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'uint', viewDimension: '2d-array' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      ],
    });
    const pipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [bindLayout] }),
      compute: { module, entryPoint: 'main' },
    });

    const tileArr = new Int32Array(tiles.length * 4);
    tiles.forEach((t, i) => tileArr.set([t.tx, t.ty, t.level, t.pixelCount], i * 4));
    const tileBuf = device.createBuffer({ size: tileArr.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    writeGpuBuffer(device, tileBuf, tileArr);
    const histBuf = device.createBuffer({ size: BINS * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const calibBuf = device.createBuffer({ size: 4 * 4 * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const calib = new Float32Array(16);
    calib.set(gains.slice(0, 4), 0);
    calib[4] = gains[4];
    calib.set(offsets.slice(0, 4), 8);
    calib[12] = offsets[4];
    writeGpuBuffer(device, calibBuf, calib);
    const uniformBuf = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    writeGpuBuffer(
      device,
      uniformBuf,
      new Float32Array([levelWidth, levelHeight, tileSize, tiles.length, BINS, RANGE_LO, RANGE_HI, 0]),
    );

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    for (const t of tiles) {
      const bg = device.createBindGroup({
        layout: bindLayout,
        entries: [
          { binding: 0, resource: { buffer: uniformBuf } },
          { binding: 1, resource: { buffer: tileBuf } },
          { binding: 2, resource: t.texture.createView({ dimension: '2d-array' }) },
          { binding: 3, resource: { buffer: histBuf } },
          { binding: 4, resource: { buffer: calibBuf } },
        ],
      });
      pass.setBindGroup(0, bg);
      pass.dispatchWorkgroups(Math.ceil((tileSize * tileSize) / 256));
    }
    pass.end();
    const staging = device.createBuffer({ size: BINS * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    encoder.copyBufferToBuffer(histBuf, 0, staging, 0, BINS * 4);
    device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const hist = new Uint32Array(staging.getMappedRange().slice(0));
    staging.unmap();
    for (const b of [tileBuf, histBuf, calibBuf, uniformBuf, staging]) b.destroy();
    return { hist, lo: RANGE_LO, hi: RANGE_HI };
  }
}

export { BINS as HIST_BINS_GLOBAL };

export function stretchRange(hist: Uint32Array, lo: number, hi: number, lowPct: number, highPct: number): [number, number] {
  return [
    percentileFromHistogram(hist, lo, hi, lowPct),
    percentileFromHistogram(hist, lo, hi, highPct),
  ];
}
