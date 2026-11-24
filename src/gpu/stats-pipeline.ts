import type { GpuCapabilities } from './device';
import { writeGpuBuffer } from './device';
import type { Calibration, MaskThresholds, Plot, PlotStats } from '../types';
import { WGSL_SAFE_DIV, type CompiledExpression } from '../core/expression';
import { plotAABB } from '../core/geometry';

/**
 * 小区统计 GPU 管线 (全设备可移植, 不依赖 shader-f32)。
 * Pass A: 每像素一线程, 一次遍历完成小区定位/掩膜/指数求值/定点累加/首遍直方图
 * Pass B..E: 自适应基数直方图, 逐遍把中位数值域缩小 256 倍
 * 均值用 64 位定点原子 (u32 高低位模拟), 中位数 4 遍后分辨率 < 1e-9。
 * storage 缓冲合并为 5 个, 满足 WebGPU 下限 maxStorageBuffersPerShaderStage=8。
 */

export const WORKGROUP_SIZE = 256;
const HIST_BINS = 256;
const HIST_PASSES = 4;
const SPATIAL_BIN_TARGET = 64;

// PlotAcc 结构 (WGSL 与 TS 共用布局): 12 个 u32 = 48 字节
const ACC_STRIDE_U32 = 12;
// 上传用 PlotGpu: 16 个 f32
export const PLOT_STRIDE_FLOATS = 16;

interface SpatialHash {
  gridW: number;
  gridH: number;
  cellSize: number;
  binStart: Uint32Array;
  binItems: Uint32Array;
}

function buildSpatialHash(plots: Plot[], width: number, height: number): SpatialHash {
  const gridW = Math.min(SPATIAL_BIN_TARGET, Math.max(8, Math.ceil(Math.sqrt(plots.length))));
  const gridH = gridW;
  const cellSize = Math.max(width / gridW, height / gridH);
  const bins: number[][] = Array.from({ length: gridW * gridH }, () => []);
  plots.forEach((p, idx) => {
    const bb = plotAABB(p);
    const x0 = Math.max(0, Math.floor(bb.x / cellSize));
    const y0 = Math.max(0, Math.floor(bb.y / cellSize));
    const x1 = Math.min(gridW - 1, Math.floor((bb.x + bb.w) / cellSize));
    const y1 = Math.min(gridH - 1, Math.floor((bb.y + bb.h) / cellSize));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) bins[y * gridW + x].push(idx);
  });
  const binStart = new Uint32Array(gridW * gridH + 1);
  const items: number[] = [];
  bins.forEach((b, i) => {
    binStart[i] = items.length;
    items.push(...b);
  });
  binStart[gridW * gridH] = items.length;
  return { gridW, gridH, cellSize, binStart, binItems: Uint32Array.from(items) };
}

function statsWgsl(expr: CompiledExpression): string {
  return /* wgsl */ `
struct Uniforms {
  width: f32, height: f32,
  tileSize: f32, tileCount: f32,
  plotCount: f32, gridW: f32, gridH: f32, cellSize: f32,
  bins: f32, inset: f32,
  soilNDVI: f32, cloudBright: f32, shadowDark: f32,
  flagFrac: f32, mode: f32, currentTile: f32,
}
struct PlotAcc {
  total: atomic<u32>,
  veg: atomic<u32>,
  cloud: atomic<u32>,
  sumPosLo: atomic<u32>,
  sumPosHi: atomic<u32>,
  sumNegLo: atomic<u32>,
  sumNegHi: atomic<u32>,
  minOrdered: atomic<u32>,
  maxOrdered: atomic<u32>,
  rangeLo: f32,
  rangeHi: f32,
  _pad: u32,
}
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var<storage, read> plots: array<vec4f>;
@group(0) @binding(2) var<storage, read> tiles: array<vec4i>;
@group(0) @binding(3) var img: texture_2d_array<u32>;
@group(0) @binding(4) var<storage, read_write> acc: array<PlotAcc>;
@group(0) @binding(5) var<storage, read_write> hist: array<atomic<u32>>;
@group(0) @binding(6) var<storage, read> calib: array<vec4f>; // [0]=gains, [1]=gain4.., [2]=offsets, [3]=offset4..
@group(0) @binding(7) var<storage, read> binStart: array<u32>;
@group(0) @binding(8) var<storage, read> binItems: array<u32>;

const FIXED_SCALE: f32 = 1000000.0;

fn gainOf(b: u32) -> f32 {
  if (b < 4u) { return calib[0][b]; }
  return calib[1].x;
}
fn offsetOf(b: u32) -> f32 {
  if (b < 4u) { return calib[2][b]; }
  return calib[3].x;
}

${WGSL_SAFE_DIV}

fn locatePlot(px: f32, py: f32) -> i32 {
  let gx = clamp(u32(px / u.cellSize), 0u, u32(u.gridW) - 1u);
  let gy = clamp(u32(py / u.cellSize), 0u, u32(u.gridH) - 1u);
  let cell = gy * u32(u.gridW) + gx;
  let start = binStart[cell];
  let end = binStart[cell + 1u];
  for (var k = start; k < end; k++) {
    let i = binItems[k];
    // plots 为 vec4f 数组, 每小区占 4 个 vec4 (16 f32)
    let p0 = plots[i * 4u];       // cx, cy, w, h
    let p1 = plots[i * 4u + 1u];  // cos, sin, 0, 0
    let dx = px - p0.x;
    let dy = py - p0.y;
    let lx = p1.x * dx + p1.y * dy;
    let ly = -p1.y * dx + p1.x * dy;
    if (abs(lx) <= p0.z * 0.5 - u.inset && abs(ly) <= p0.w * 0.5 - u.inset) {
      return i32(i);
    }
  }
  return -1;
}

fn loadRefl(coord: vec2i, b: u32) -> f32 {
  let dn = f32(textureLoad(img, coord, b, 0).r);
  return gainOf(b) * dn + offsetOf(b);
}

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let local = gid.x;
  let ts = u32(u.tileSize);
  let perTile = ts * ts;
  if (local >= perTile) { return; }
  let tileIdx = u32(u.currentTile);
  let tile = tiles[tileIdx];
  let lx = local % ts;
  let ly = local / ts;
  let gx = u32(tile.x) * ts + lx;
  let gy = u32(tile.y) * ts + ly;
  if (f32(gx) >= u.width || f32(gy) >= u.height) { return; }

  let pidx = locatePlot(f32(gx) + 0.5, f32(gy) + 0.5);
  if (pidx < 0) { return; }
  let pi = u32(pidx);

  var refl: array<f32, 5>;
  for (var b = 0u; b < 5u; b++) { refl[b] = loadRefl(vec2i(i32(lx), i32(ly)), b); }
  let b0 = refl[0]; let b1 = refl[1]; let b2 = refl[2]; let b3 = refl[3]; let b4 = refl[4];

  let visible = (b0 + b1 + b2) / 3.0;
  let ndvi = safeDiv(b4 - b2, b4 + b2);
  let isCloud = visible > u.cloudBright;
  let isShadow = visible < u.shadowDark;

  if (u.mode < 0.5) { atomicAdd(&acc[pi].total, 1u); }
  if (isCloud || isShadow) {
    if (u.mode < 0.5) { atomicAdd(&acc[pi].cloud, 1u); }
    return;
  }
  if (ndvi < u.soilNDVI) { return; }

  let idxv = ${expr.wgsl};
  if (idxv != idxv || abs(idxv) > 1e30) { return; }

  if (u.mode < 0.5) {
    atomicAdd(&acc[pi].veg, 1u);
    let q = u32(clamp(abs(idxv) * FIXED_SCALE, 0.0, 1000000.0));
    // 内联 64 位原子加 (避免 WGSL 指针别名限制)
    if (idxv >= 0.0) {
      let oldLo = atomicAdd(&acc[pi].sumPosLo, q);
      if (oldLo > 0xffffffffu - q) { atomicAdd(&acc[pi].sumPosHi, 1u); }
    } else {
      let oldLo = atomicAdd(&acc[pi].sumNegLo, q);
      if (oldLo > 0xffffffffu - q) { atomicAdd(&acc[pi].sumNegHi, 1u); }
    }
    let raw = bitcast<u32>(idxv);
    let ordered = select(raw ^ 0x7fffffffu, raw ^ 0x80000000u, (raw & 0x80000000u) != 0u);
    atomicMin(&acc[pi].minOrdered, ordered);
    atomicMax(&acc[pi].maxOrdered, ordered);
  }

  let lo = acc[pi].rangeLo;
  let hi = acc[pi].rangeHi;
  var bin = u32((idxv - lo) / max(hi - lo, 1e-12) * u.bins);
  bin = clamp(bin, 0u, u32(u.bins) - 1u);
  atomicAdd(&hist[pi * u32(u.bins) + bin], 1u);
}
`;
}

function histogramRefineWgsl(): string {
  return /* wgsl */ `
struct Uniforms { plotCount: f32, bins: f32 }
struct PlotAccLite {
  total: atomic<u32>, veg: atomic<u32>, cloud: atomic<u32>,
  sumPosLo: atomic<u32>, sumPosHi: atomic<u32>, sumNegLo: atomic<u32>, sumNegHi: atomic<u32>,
  minOrdered: atomic<u32>, maxOrdered: atomic<u32>,
  rangeLo: f32, rangeHi: f32, _pad: u32,
}
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var<storage, read_write> hist: array<atomic<u32>>;
@group(0) @binding(2) var<storage, read_write> acc: array<PlotAccLite>;

@compute @workgroup_size(256)
fn refine(@builtin(global_invocation_id) gid: vec3u) {
  let pi = gid.x;
  if (pi >= u32(u.plotCount)) { return; }
  let bins = u32(u.bins);
  let base = pi * bins;
  let veg = atomicLoad(&acc[pi].veg);
  if (veg == 0u) { return; }
  let lo = acc[pi].rangeLo;
  let hi = acc[pi].rangeHi;
  let width = (hi - lo) / u.bins;

  let targetRank = f32(veg) * 0.5;
  var accCount = 0u;
  var hitBin = 0u;
  for (var b = 0u; b < bins; b++) {
    let c = atomicLoad(&hist[base + b]);
    if (f32(accCount + c) >= targetRank) { hitBin = b; break; }
    accCount += c;
  }
  acc[pi].rangeLo = lo + f32(hitBin) * width;
  acc[pi].rangeHi = lo + f32(hitBin + 1u) * width;

  for (var b = 0u; b < bins; b++) { atomicStore(&hist[base + b], 0u); }
}
`;
}

export interface GpuStatsTile {
  texture: GPUTexture;
  tx: number;
  ty: number;
  level: number;
  pixelCount: number;
}

export interface GpuStatsOptions {
  plots: Plot[];
  calibration: Calibration;
  mask: MaskThresholds;
  flagFraction: number;
  imageId: string;
  indexName: string;
  expr: CompiledExpression;
  tiles: GpuStatsTile[];
  imageWidth: number;
  imageHeight: number;
  tileSize: number;
  inset: number;
}

/** 调试: 在 GPU 上对给定像素点跑空间哈希定位, 返回命中的小区索引 */
export async function debugLocatePlot(
  caps: GpuCapabilities,
  plots: Plot[],
  imageWidth: number,
  imageHeight: number,
  inset: number,
  testPixels: { x: number; y: number }[],
): Promise<number[]> {
  const device = caps.device;
  const hash = buildSpatialHash(plots, imageWidth, imageHeight);
  const plotBuf = device.createBuffer({ size: plots.length * PLOT_STRIDE_FLOATS * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const plotArr = new Float32Array(plots.length * PLOT_STRIDE_FLOATS);
  plots.forEach((p, i) => {
    const o = i * PLOT_STRIDE_FLOATS;
    plotArr.set([p.cx, p.cy, p.w, p.h], o);
    plotArr.set([Math.cos(p.angleRad), Math.sin(p.angleRad), 0, 0], o + 4);
  });
  writeGpuBuffer(device, plotBuf, plotArr);
  const binStartBuf = device.createBuffer({ size: hash.binStart.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const binItemsBuf = device.createBuffer({ size: hash.binItems.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  writeGpuBuffer(device, binStartBuf, hash.binStart);
  writeGpuBuffer(device, binItemsBuf, hash.binItems);
  const pixelBuf = device.createBuffer({ size: testPixels.length * 2 * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const pxArr = new Float32Array(testPixels.length * 2);
  testPixels.forEach((p, i) => pxArr.set([p.x, p.y], i * 2));
  writeGpuBuffer(device, pixelBuf, pxArr);
  const outBuf = device.createBuffer({ size: testPixels.length * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const uniformBuf = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  writeGpuBuffer(
    device,
    uniformBuf,
    new Float32Array([hash.gridW, hash.gridH, hash.cellSize, inset, testPixels.length, 0, 0, 0]),
  );

  const wgsl = /* wgsl */ `
struct U { gridW: f32, gridH: f32, cellSize: f32, inset: f32, count: f32, _a: f32, _b: f32, _c: f32 }
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read> plots: array<vec4f>;
@group(0) @binding(2) var<storage, read> binStart: array<u32>;
@group(0) @binding(3) var<storage, read> binItems: array<u32>;
@group(0) @binding(4) var<storage, read> pixels: array<vec2f>;
@group(0) @binding(5) var<storage, read_write> out: array<i32>;

@compute @workgroup_size(64)
fn dbg(@builtin(global_invocation_id) gid: vec3u) {
  let idx = gid.x;
  if (idx >= arrayLength(&out)) { return; }
  let px = pixels[idx].x;
  let py = pixels[idx].y;
  let gx = clamp(u32(px / u.cellSize), 0u, u32(u.gridW) - 1u);
  let gy = clamp(u32(py / u.cellSize), 0u, u32(u.gridH) - 1u);
  let cell = gy * u32(u.gridW) + gx;
  let start = binStart[cell];
  let end = binStart[cell + 1u];
  var found = -1;
  for (var k = start; k < end; k++) {
    let i = binItems[k];
    let p0 = plots[i * 4u];
    let p1 = plots[i * 4u + 1u];
    let dx = px - p0.x;
    let dy = py - p0.y;
    let lx = p1.x * dx + p1.y * dy;
    let ly = -p1.y * dx + p1.x * dy;
    if (abs(lx) <= p0.z * 0.5 - u.inset && abs(ly) <= p0.w * 0.5 - u.inset) { found = i32(i); }
  }
  out[idx] = found;
}
`;
  const module = device.createShaderModule({ code: wgsl });
  const bindLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
    ],
  });
  const pipeline = device.createComputePipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [bindLayout] }),
    compute: { module, entryPoint: 'dbg' },
  });
  const bg = device.createBindGroup({
    layout: bindLayout,
    entries: [
      { binding: 0, resource: { buffer: uniformBuf } },
      { binding: 1, resource: { buffer: plotBuf } },
      { binding: 2, resource: { buffer: binStartBuf } },
      { binding: 3, resource: { buffer: binItemsBuf } },
      { binding: 4, resource: { buffer: pixelBuf } },
      { binding: 5, resource: { buffer: outBuf } },
    ],
  });
  const enc = device.createCommandEncoder();
  const pass = enc.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bg);
  pass.dispatchWorkgroups(Math.ceil(testPixels.length / 64));
  pass.end();
  const staging = device.createBuffer({ size: outBuf.size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  enc.copyBufferToBuffer(outBuf, 0, staging, 0, outBuf.size);
  device.queue.submit([enc.finish()]);
  await staging.mapAsync(GPUMapMode.READ);
  const result = Array.from(new Int32Array(staging.getMappedRange().slice(0)));
  staging.unmap();
  for (const b of [plotBuf, binStartBuf, binItemsBuf, pixelBuf, outBuf, uniformBuf, staging]) b.destroy();
  return result;
}

export class StatsPipeline {
  private module: GPUShaderModule;
  private refineModule: GPUShaderModule;
  private bindLayout: GPUBindGroupLayout;
  private refineBindLayout: GPUBindGroupLayout;

  constructor(private caps: GpuCapabilities, expr: CompiledExpression) {
    const device = caps.device;
    this.module = device.createShaderModule({ code: statsWgsl(expr) });
    this.refineModule = device.createShaderModule({ code: histogramRefineWgsl() });
    this.bindLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'uint', viewDimension: '2d-array' } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 8, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      ],
    });
    this.refineBindLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      ],
    });
  }

  async run(opts: GpuStatsOptions): Promise<PlotStats[]> {
    const device = this.caps.device;
    const plotCount = opts.plots.length;
    const tileCount = opts.tiles.length;
    const bins = HIST_BINS;
    const hash = buildSpatialHash(opts.plots, opts.imageWidth, opts.imageHeight);

    const storage = (count: number) =>
      device.createBuffer({ size: Math.max(4, count * 4), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
    const plotBuf = this.makePlotsBuffer(opts.plots);
    const tileBuf = this.makeTilesBuffer(opts.tiles);
    // 累加器: 每小区 12 u32
    const accBuf = storage(plotCount * ACC_STRIDE_U32);
    const accInit = new Uint32Array(plotCount * ACC_STRIDE_U32);
    for (let i = 0; i < plotCount; i++) {
      accInit[i * ACC_STRIDE_U32 + 7] = 0xffffffff; // minOrdered
      // WGSL PlotAcc: 0..8 为 u32 成员, rangeLo=索引9, rangeHi=索引10, _pad=11
      const f32 = new Float32Array(accInit.buffer);
      f32[i * ACC_STRIDE_U32 + 9] = -1;
      f32[i * ACC_STRIDE_U32 + 10] = 1;
    }
    writeGpuBuffer(device, accBuf, accInit);
    const hist = storage(plotCount * bins);
    const calibBuf = device.createBuffer({ size: 4 * 4 * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const calib = new Float32Array(16);
    calib.set(opts.calibration.gains.slice(0, 4), 0);
    calib[4] = opts.calibration.gains[4];
    calib.set(opts.calibration.offsets.slice(0, 4), 8);
    calib[12] = opts.calibration.offsets[4];
    writeGpuBuffer(device, calibBuf, calib);
    const binStartBuf = storage(hash.binStart.length);
    const binItemsBuf = storage(hash.binItems.length);
    writeGpuBuffer(device, binStartBuf, hash.binStart);
    writeGpuBuffer(device, binItemsBuf, hash.binItems);
    const refineUniformBuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

    const uniformBufs: GPUBuffer[] = opts.tiles.map(() =>
      device.createBuffer({ size: 24 * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
    );

    const writeUniform = (mode: number, currentTile: number, buf: GPUBuffer) => {
      const u = new Float32Array(24);
      u.set(
        [
          opts.imageWidth, opts.imageHeight, opts.tileSize, tileCount,
          plotCount, hash.gridW, hash.gridH, hash.cellSize,
          bins, opts.inset,
          opts.mask.soilNDVI, opts.mask.cloudBright, opts.mask.shadowDark,
          opts.flagFraction, mode, currentTile,
          0, 0, 0, 0, 0, 0, 0, 0,
        ],
        0,
      );
      writeGpuBuffer(device, buf, u);
    };
    // 首遍与收窄遍各一套 uniform (mode 不同), 在 pass 外预写
    uniformBufs.forEach((buf, i) => writeUniform(0, i, buf));
    const refineUniformBufs: GPUBuffer[] = opts.tiles.map(() =>
      device.createBuffer({ size: 24 * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
    );
    refineUniformBufs.forEach((buf, i) => writeUniform(1, i, buf));

    const pipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.bindLayout] }),
      compute: { module: this.module, entryPoint: 'main' },
    });
    const refinePipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.refineBindLayout] }),
      compute: { module: this.refineModule, entryPoint: 'refine' },
    });

    const makeEntries = (uniform: GPUBuffer) => [
      { binding: 0, resource: { buffer: uniform } },
      { binding: 1, resource: { buffer: plotBuf } },
      { binding: 2, resource: { buffer: tileBuf } },
      { binding: 4, resource: { buffer: accBuf } },
      { binding: 5, resource: { buffer: hist } },
      { binding: 6, resource: { buffer: calibBuf } },
      { binding: 7, resource: { buffer: binStartBuf } },
      { binding: 8, resource: { buffer: binItemsBuf } },
    ];

    const encodePixelPass = (mode: number) => {
      const bufs = mode < 0.5 ? uniformBufs : refineUniformBufs;
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      opts.tiles.forEach((t, tileIdx) => {
        const bg = device.createBindGroup({
          layout: this.bindLayout,
          entries: [...makeEntries(bufs[tileIdx]), { binding: 3, resource: t.texture.createView({ dimension: '2d-array' }) }],
        });
        pass.setBindGroup(0, bg);
        pass.dispatchWorkgroups(Math.ceil((opts.tileSize * opts.tileSize) / WORKGROUP_SIZE));
      });
      pass.end();
      device.queue.submit([encoder.finish()]);
    };

    encodePixelPass(0);

    const refineBG = device.createBindGroup({
      layout: this.refineBindLayout,
      entries: [
        { binding: 0, resource: { buffer: refineUniformBuf } },
        { binding: 1, resource: { buffer: hist } },
        { binding: 2, resource: { buffer: accBuf } },
      ],
    });
    writeGpuBuffer(device, refineUniformBuf, new Float32Array([plotCount, bins, 0, 0]));
    // 自适应基数直方图: 逐遍把中位数值域缩小 256 倍
    for (let hp = 0; hp < HIST_PASSES - 1; hp++) {
      const enc = device.createCommandEncoder();
      const cp = enc.beginComputePass();
      cp.setPipeline(refinePipeline);
      cp.setBindGroup(0, refineBG);
      cp.dispatchWorkgroups(Math.ceil(plotCount / 256));
      cp.end();
      device.queue.submit([enc.finish()]);
      encodePixelPass(1);
    }

    await device.queue.onSubmittedWorkDone();

    const [accU32, histArr] = await Promise.all([
      readU32(device, accBuf, plotCount * ACC_STRIDE_U32),
      readU32(device, hist, plotCount * bins),
    ]);
    const accF32 = new Float32Array(accU32.buffer.slice(0));

    const results: PlotStats[] = opts.plots.map((p, i) => {
      const o = i * ACC_STRIDE_U32;
      const total = accU32[o];
      const veg = accU32[o + 1];
      const cs = accU32[o + 2];
      const pos64 = accU32[o + 4] * 4294967296 + accU32[o + 3];
      const neg64 = accU32[o + 6] * 4294967296 + accU32[o + 5];
      const mean = veg > 0 ? (pos64 - neg64) / 1e6 / veg : NaN;
      let median = NaN;
      if (veg > 0) {
        const base = i * bins;
        const lo = accF32[o + 9];
        const hi = accF32[o + 10];
        const width = (hi - lo) / bins;
        const targetRank = veg * 0.5;
        let accCount = 0;
        for (let b = 0; b < bins; b++) {
          const c = histArr[base + b];
          if (accCount + c >= targetRank) {
            const frac = c === 0 ? 0 : (targetRank - accCount) / c;
            median = lo + (b + frac) * width;
            break;
          }
          accCount += c;
        }
      }
      const min = veg > 0 ? decodeOrdered(accU32[o + 7]) : NaN;
      const max = veg > 0 ? decodeOrdered(accU32[o + 8]) : NaN;
      const csFraction = total > 0 ? cs / total : 0;
      return {
        plotId: p.id,
        imageId: opts.imageId,
        indexName: opts.indexName,
        totalPixels: total,
        vegPixels: veg,
        cloudShadowPixels: cs,
        mean,
        median,
        min,
        max,
        coverage: total > 0 ? veg / total : 0,
        cloudShadowFraction: csFraction,
        flagged: csFraction > opts.flagFraction || veg === 0,
      };
    });

    for (const b of [
      plotBuf, tileBuf, accBuf, hist, calibBuf, binStartBuf, binItemsBuf,
      refineUniformBuf, ...uniformBufs, ...refineUniformBufs,
    ]) {
      b.destroy();
    }
    return results;
  }

  private makePlotsBuffer(plots: Plot[]): GPUBuffer {
    const arr = new Float32Array(plots.length * PLOT_STRIDE_FLOATS);
    plots.forEach((p, i) => {
      const o = i * PLOT_STRIDE_FLOATS;
      arr.set([p.cx, p.cy, p.w, p.h], o);
      arr.set([Math.cos(p.angleRad), Math.sin(p.angleRad), 0, 0], o + 4);
      arr.set([p.row, p.col, p.index, 0], o + 8);
    });
    const buf = this.caps.device.createBuffer({ size: arr.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    writeGpuBuffer(this.caps.device, buf, arr);
    return buf;
  }

  private makeTilesBuffer(tiles: GpuStatsTile[]): GPUBuffer {
    const arr = new Int32Array(tiles.length * 4);
    tiles.forEach((t, i) => arr.set([t.tx, t.ty, t.level, t.pixelCount], i * 4));
    const buf = this.caps.device.createBuffer({ size: arr.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    writeGpuBuffer(this.caps.device, buf, arr);
    return buf;
  }
}

function decodeOrdered(ordered: number): number {
  const raw = ordered & 0x80000000 ? (ordered ^ 0xffffffff) >>> 0 : (ordered ^ 0x80000000) >>> 0;
  return new Float32Array(new Uint32Array([raw]).buffer)[0];
}

async function readU32(device: GPUDevice, buf: GPUBuffer, count: number): Promise<Uint32Array> {
  const staging = device.createBuffer({ size: count * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const enc = device.createCommandEncoder();
  enc.copyBufferToBuffer(buf, 0, staging, 0, count * 4);
  device.queue.submit([enc.finish()]);
  await staging.mapAsync(GPUMapMode.READ);
  const out = new Uint32Array(staging.getMappedRange().slice(0));
  staging.unmap();
  staging.destroy();
  return out;
}
