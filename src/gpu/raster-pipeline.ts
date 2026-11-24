import type { GpuCapabilities } from './device';
import { writeGpuBuffer } from './device';
import { WGSL_SAFE_DIV, type CompiledExpression } from '../core/expression';

/**
 * 影像渲染管线。
 * 每个可见切片一个实例化四边形; 片元着色器手动双线性采样 R16Uint 纹理数组,
 * 应用辐射定标 -> 波段表达式 -> 直方图百分比拉伸 -> 色带 LUT。
 * uniform 全部按 vec4 对齐, 避免 WGSL 结构体 padding 问题。
 */

export interface RenderUniforms {
  viewportW: number;
  viewportH: number;
  level: number;
  levelScale: number;
  cameraX: number;
  cameraY: number;
  zoom: number;
  showMask: number;
  gains: number[]; // 5
  offsets: number[]; // 5
  stretchLow: number;
  stretchHigh: number;
  soilNDVI: number;
  cloudBright: number;
  shadowDark: number;
  opacity: number;
}

// Uniforms 为 8 个 vec4 (p0, p1, gains, gain4, offsets, offset4, stretch, mask) = 32 f32 = 128B
export const UNIFORM_FLOATS = 32;

const COMMON_WGSL = /* wgsl */ `
struct Uniforms {
  p0: vec4f,        // viewportW, viewportH, level, levelScale
  p1: vec4f,        // cameraX, cameraY, zoom, showMask
  gains: vec4f,     // b0..b3
  gain4: vec4f,     // b4, _, _, _
  offsets: vec4f,   // b0..b3
  offset4: vec4f,   // b4, _, _, _
  stretch: vec4f,   // low, high, _, _
  mask: vec4f,      // soilNDVI, cloudBright, shadowDark, opacity
}

struct TileDraw {
  originX: f32, originY: f32,
  screenX: f32, screenY: f32,
  size: f32,
}

fn gainOf(b: u32) -> f32 {
  if (b < 4u) { return u.gains[b]; }
  return u.gain4.x;
}
fn offsetOf(b: u32) -> f32 {
  if (b < 4u) { return u.offsets[b]; }
  return u.offset4.x;
}
`;

const VERT_WGSL = /* wgsl */ `
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var<storage, read> tiles: array<TileDraw>;

struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) @interpolate(flat) tileIdx: u32,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VSOut {
  var corner = array<vec2f, 6>(
    vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0),
    vec2f(0.0, 0.0), vec2f(1.0, 1.0), vec2f(0.0, 1.0),
  );
  let t = tiles[ii];
  let c = corner[vi];
  let sp = vec2f(t.screenX + c.x * t.size, t.screenY + c.y * t.size);
  let ndc = vec2f(sp.x / u.p0.x * 2.0 - 1.0, 1.0 - sp.y / u.p0.y * 2.0);
  var out: VSOut;
  out.pos = vec4f(ndc, 0.0, 1.0);
  out.uv = c;
  out.tileIdx = ii;
  return out;
}
`;

function fragWgsl(expr: CompiledExpression): string {
  return /* wgsl */ `
// Uniforms/TileDraw/VSOut 已在 COMMON_WGSL 与 VERT_WGSL 声明, 此处只加片元阶段特有的纹理绑定
@group(0) @binding(2) var img: texture_2d_array<u32>;
@group(0) @binding(3) var samp: sampler;
@group(0) @binding(4) var lut: texture_2d<f32>;

${WGSL_SAFE_DIV}

fn texAt(coord: vec2i, b: u32) -> f32 {
  return f32(textureLoad(img, coord, b, 0).r);
}

fn loadBand(coord: vec2f, b: u32) -> f32 {
  let dim = vec2f(textureDimensions(img).xy);
  let pc = clamp(coord, vec2f(0.0), dim - vec2f(1.0001));
  let base = floor(pc);
  let frac = pc - base;
  let i00 = vec2i(i32(base.x), i32(base.y));
  let i10 = i00 + vec2i(1, 0);
  let i01 = i00 + vec2i(0, 1);
  let i11 = i00 + vec2i(1, 1);
  let hi = vec2i(i32(dim.x - 1.0), i32(dim.y - 1.0));
  let v00 = texAt(min(i00, hi), b);
  let v10 = texAt(min(i10, hi), b);
  let v01 = texAt(min(i01, hi), b);
  let v11 = texAt(min(i11, hi), b);
  let top = mix(v00, v10, frac.x);
  let bot = mix(v01, v11, frac.x);
  return mix(top, bot, frac.y);
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
  let td = tiles[in.tileIdx];
  let tileCoord = in.uv * vec2f(td.size, td.size);
  var refl: array<f32, 5>;
  for (var b = 0u; b < 5u; b++) {
    let dn = loadBand(tileCoord, b);
    refl[b] = gainOf(b) * dn + offsetOf(b);
  }
  let b0 = refl[0]; let b1 = refl[1]; let b2 = refl[2]; let b3 = refl[3]; let b4 = refl[4];
  let idx = ${expr.wgsl};

  let visible = (b0 + b1 + b2) / 3.0;
  let ndvi = safeDiv(b4 - b2, b4 + b2);
  let isCloud = visible > u.mask.y;
  let isShadow = visible < u.mask.z;
  let isSoil = ndvi < u.mask.x;

  if (u.p1.w > 0.5) {
    if (isCloud) { return vec4f(1.0, 1.0, 1.0, u.mask.w * 0.85); }
    if (isShadow) { return vec4f(0.15, 0.15, 0.35, u.mask.w * 0.85); }
    if (isSoil) { return vec4f(0.55, 0.35, 0.2, u.mask.w * 0.5); }
  }

  let t01 = clamp((idx - u.stretch.x) / max(u.stretch.y - u.stretch.x, 1e-6), 0.0, 1.0);
  let color = textureLoad(lut, vec2i(i32(clamp(u32(t01 * 255.0), 0u, 255u)), 0), 0).rgb;
  return vec4f(color, u.mask.w);
}
`;
}

export interface RenderPipelineHandle {
  pipeline: GPURenderPipeline;
  bindLayout: GPUBindGroupLayout;
}

export function createRasterPipeline(caps: GpuCapabilities, expr: CompiledExpression): RenderPipelineHandle {
  const device = caps.device;
  const bindLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'uint', viewDimension: '2d-array' } },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d' } },
    ],
  });
  const module = device.createShaderModule({
    code: COMMON_WGSL + '\n' + VERT_WGSL + '\n' + fragWgsl(expr),
  });
  const pipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [bindLayout] }),
    vertex: { module, entryPoint: 'vs' },
    fragment: { module, entryPoint: 'fs', targets: [{ format: caps.format }] },
    primitive: { topology: 'triangle-list' },
  });
  return { pipeline, bindLayout };
}

/** 色带 LUT 纹理 (2D 1x256, rgba) */
export function createLutTexture(device: GPUDevice, rgba: Uint8ClampedArray): GPUTexture {
  const tex = device.createTexture({
    size: { width: 256, height: 1, depthOrArrayLayers: 1 },
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture({ texture: tex }, rgba as BufferSource, { bytesPerRow: 256 * 4, rowsPerImage: 1 }, { width: 256, height: 1 });
  return tex;
}

export function makeUniformBuffer(device: GPUDevice): GPUBuffer {
  // uniform 缓冲大小必须按 16 字节对齐: 28 f32=112B -> 128B
  const size = Math.ceil((UNIFORM_FLOATS * 4) / 16) * 16;
  return device.createBuffer({ size, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
}

export function writeUniforms(device: GPUDevice, buf: GPUBuffer, u: RenderUniforms): void {
  const arr = new Float32Array(UNIFORM_FLOATS);
  arr.set([u.viewportW, u.viewportH, u.level, u.levelScale], 0);
  arr.set([u.cameraX, u.cameraY, u.zoom, u.showMask], 4);
  arr.set([u.gains[0], u.gains[1], u.gains[2], u.gains[3]], 8);
  arr.set([u.gains[4], 0, 0, 0], 12);
  arr.set([u.offsets[0], u.offsets[1], u.offsets[2], u.offsets[3]], 16);
  arr.set([u.offsets[4], 0, 0, 0], 20);
  arr.set([u.stretchLow, u.stretchHigh, 0, 0], 24);
  arr.set([u.soilNDVI, u.cloudBright, u.shadowDark, u.opacity], 28);
  writeGpuBuffer(device, buf, arr);
}
