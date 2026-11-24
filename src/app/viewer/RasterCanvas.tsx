import { useEffect, useRef } from 'react';
import type { GpuCapabilities } from '../../gpu/device';
import {
  createLutTexture,
  createRasterPipeline,
  makeUniformBuffer,
  writeUniforms,
  type RenderPipelineHandle,
  type RenderUniforms,
} from '../../gpu/raster-pipeline';
import { writeGpuBuffer } from '../../gpu/device';
import type { CompiledExpression } from '../../core/expression';
import type { Calibration, FlightImage, MaskThresholds } from '../../types';
import { computeVisibleTiles, type Camera } from './camera';

export interface RasterCanvasProps {
  caps: GpuCapabilities;
  image: FlightImage;
  camera: Camera;
  expr: CompiledExpression;
  calibration: Calibration;
  mask: MaskThresholds;
  showMask: boolean;
  stretch: [number, number];
  lutRgba: Uint8ClampedArray;
  acquireTexture: (level: number, ty: number, tx: number) => Promise<GPUTexture>;
}

// 与 WGSL TileDraw 一致: 5 个 f32
const TILE_DRAW_FLOATS = 5;

export function RasterCanvas(props: RasterCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const rafRef = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const caps = props.caps;
    const device = caps.device;
    let disposed = false;
    let handle: RenderPipelineHandle | null = null;
    let currentExpr = '';
    // LUT 纹理按色带数据缓存, 避免每帧重建
    let lut: GPUTexture | null = null;
    let lutKey = '';
    const sampler = device.createSampler({ magFilter: 'nearest', minFilter: 'nearest' });

    const resize = () => {
      const parent = canvas.parentElement!;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.max(1, Math.floor(parent.clientWidth * dpr));
      const h = Math.max(1, Math.max(1, Math.floor(parent.clientHeight * dpr)));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
    };
    const ro = new ResizeObserver(resize);
    ro.observe(canvas.parentElement!);
    resize();

    const clear = () => {
      const enc = device.createCommandEncoder();
      const rp = enc.beginRenderPass({
        colorAttachments: [
          { view: caps.context.getCurrentTexture().createView(), clearValue: { r: 0.02, g: 0.03, b: 0.05, a: 1 }, loadOp: 'clear', storeOp: 'store' },
        ],
      });
      rp.end();
      device.queue.submit([enc.finish()]);
    };

    const render = async () => {
      if (disposed) return;
      const p = propsRef.current;
      resize();
      const viewW = canvas.width;
      const viewH = canvas.height;
      if (currentExpr !== p.expr.source) {
        handle = createRasterPipeline(caps, p.expr);
        currentExpr = p.expr.source;
      }
      if (!handle) {
        rafRef.current = requestAnimationFrame(render);
        return;
      }
      const visible = computeVisibleTiles(p.image, p.camera, viewW, viewH);
      if (visible.length === 0) {
        clear();
        rafRef.current = requestAnimationFrame(render);
        return;
      }
      const textures = await Promise.all(
        visible.map(async (t) => {
          try {
            return { t, tex: await p.acquireTexture(t.level, t.ty, t.tx) };
          } catch {
            return { t, tex: undefined };
          }
        }),
      );
      if (disposed) return;
      const drawable = textures.filter((x): x is { t: (typeof textures)[number]['t']; tex: GPUTexture } => !!x.tex);
      if (drawable.length === 0) {
        clear();
        rafRef.current = requestAnimationFrame(render);
        return;
      }

      const level = drawable[0].t.level;
      const levelFactor = 2 ** level;
      const instances = new Float32Array(drawable.length * TILE_DRAW_FLOATS);
      drawable.forEach((e, i) => {
        instances.set([e.t.originLevelX, e.t.originLevelY, e.t.screenX, e.t.screenY, e.t.size], i * TILE_DRAW_FLOATS);
      });
      const instanceBuf = device.createBuffer({
        size: Math.max(16, instances.byteLength),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      writeGpuBuffer(device, instanceBuf, instances);

      const uniformBuf = makeUniformBuffer(device);
      const u: RenderUniforms = {
        viewportW: viewW,
        viewportH: viewH,
        level,
        levelScale: 1 / levelFactor,
        cameraX: 0,
        cameraY: 0,
        zoom: p.camera.scale * levelFactor,
        showMask: p.showMask ? 1 : 0,
        gains: p.calibration.gains,
        offsets: p.calibration.offsets,
        stretchLow: p.stretch[0],
        stretchHigh: p.stretch[1],
        soilNDVI: p.mask.soilNDVI,
        cloudBright: p.mask.cloudBright,
        shadowDark: p.mask.shadowDark,
        opacity: 1,
      };
      writeUniforms(device, uniformBuf, u);
      const key = Array.from(p.lutRgba).join(',');
      if (!lut || key !== lutKey) {
        lut?.destroy();
        lut = createLutTexture(device, p.lutRgba);
        lutKey = key;
      }

      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          { view: caps.context.getCurrentTexture().createView(), clearValue: { r: 0.02, g: 0.03, b: 0.05, a: 1 }, loadOp: 'clear', storeOp: 'store' },
        ],
      });
      pass.setPipeline(handle.pipeline);
      const activeLut = lut;
      drawable.forEach((e, i) => {
        const bg = device.createBindGroup({
          layout: handle!.bindLayout,
          entries: [
            { binding: 0, resource: { buffer: uniformBuf } },
            { binding: 1, resource: { buffer: instanceBuf } },
            { binding: 2, resource: e.tex.createView({ dimension: '2d-array' }) },
            { binding: 3, resource: sampler },
            { binding: 4, resource: activeLut.createView() },
          ],
        });
        pass.setBindGroup(0, bg);
        pass.draw(6, 1, 0, i);
      });
      pass.end();
      device.queue.submit([encoder.finish()]);
      // instance/uniform 每帧重建, GPU 读完后回收; LUT 与 sampler 跨帧复用, 卸载时统一销毁
      const frameBufs = [instanceBuf, uniformBuf];
      void device.queue.onSubmittedWorkDone().then(() => {
        if (!disposed) frameBufs.forEach((b) => b.destroy());
      });
      rafRef.current = requestAnimationFrame(render);
    };
    rafRef.current = requestAnimationFrame(render);
    return () => {
      disposed = true;
      cancelAnimationFrame(rafRef.current);
      ro.disconnect();
      lut?.destroy();
    };
  }, [props.caps, props.image, props.expr]);

  return <canvas ref={canvasRef} />;
}
