import type { FlightImage } from '../../types';
import type { GpuCapabilities } from '../../gpu/device';
import { RasterService } from '../../io/raster-service';
import type { CompiledExpression } from '../../core/expression';
import type { Calibration, MaskThresholds } from '../../types';

/**
 * 查看器会话: 持有当前影像的 RasterService (两级缓存)。
 * 切换影像时 dispose 旧会话, 保证内存/显存不随浏览历史增长。
 */
export class ViewerSession {
  service: RasterService;

  constructor(
    public caps: GpuCapabilities,
    public image: FlightImage,
    ramBudgetBytes: number,
    gpuBudgetBytes: number,
  ) {
    this.service = new RasterService(caps, image, ramBudgetBytes, gpuBudgetBytes);
  }

  dispose(): void {
    this.service.dispose();
  }
}

export interface RenderParams {
  expr: CompiledExpression;
  calibration: Calibration;
  mask: MaskThresholds;
  showMask: boolean;
  stretchLow: number;
  stretchHigh: number;
  lutRgba: Uint8ClampedArray;
  opacity: number;
}
