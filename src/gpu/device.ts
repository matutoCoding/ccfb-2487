/** WebGPU 设备初始化与能力检测 */
export interface GpuCapabilities {
  device: GPUDevice;
  context: GPUCanvasContext;
  format: GPUTextureFormat;
  supportsF32Atomic: boolean;
  maxStorageBuffer: number;
  maxTextureDimension2d: number;
  maxBufferSize: number;
}

let capabilitiesPromise: Promise<GpuCapabilities> | null = null;

export async function initWebGPU(canvas: HTMLCanvasElement): Promise<GpuCapabilities> {
  if (!navigator.gpu) throw new Error('当前浏览器不支持 WebGPU, 请使用最新版 Chrome/Edge');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('未找到可用的 GPU 适配器');
  // 统计管线使用 u32 原子模拟 64 位定点累加, 无需 shader-f32 特性, 全设备可移植
  const supportsF32Atomic = adapter.features.has('shader-f32' as unknown as GPUFeatureName);
  const device = await adapter.requestDevice();
  const context = canvas.getContext('webgpu');
  if (!context) throw new Error('无法创建 WebGPU canvas context');
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: 'opaque' });
  const limits = adapter.limits;
  return {
    device,
    context,
    format,
    supportsF32Atomic,
    maxStorageBuffer: limits.maxStorageBufferBindingSize,
    maxTextureDimension2d: limits.maxTextureDimension2D,
    maxBufferSize: limits.maxBufferSize,
  };
}

export function getCapabilities(canvas?: HTMLCanvasElement): Promise<GpuCapabilities> {
  if (!capabilitiesPromise) {
    if (!canvas) throw new Error('首次初始化需要 canvas');
    capabilitiesPromise = initWebGPU(canvas);
  }
  return capabilitiesPromise;
}

export async function hasWebGPU(): Promise<boolean> {
  if (!navigator.gpu) return false;
  try {
    const adapter = await navigator.gpu.requestAdapter();
    return !!adapter;
  } catch {
    return false;
  }
}

export function resetGpuForTest(): void {
  capabilitiesPromise = null;
}

/** TS 5.7+ TypedArray<ArrayBufferLike> 与 WebGPU BufferSource 之间的桥接 */
export function writeGpuBuffer(device: GPUDevice, buffer: GPUBuffer, data: ArrayBufferView | ArrayBuffer, offset = 0): void {
  device.queue.writeBuffer(buffer, offset, data as BufferSource);
}
