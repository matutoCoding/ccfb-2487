# 育种小区影像表型系统 (TypeScript + WebGPU + IndexedDB)

纯浏览器端的多光谱无人机影像育种表型分析系统。五波段 GeoTIFF 分块读入、浏览器内自建
影像金字塔切片存入 IndexedDB, 所有指数计算与小区统计在 WebGPU 上一趟完成, 不依赖后端。

## 技术栈与关键决策

- **语言/框架**: TypeScript 5.9 + React 18 + Zustand + Vite
- **GPU**: 原生 WebGPU (compute + render), 无 WebGL 回退依赖
- **存储**: IndexedDB (切片/元数据/统计), 两级 LRU 缓存 (RAM `TileCache` + 显存 `GpuTileCache`)
- **TIFF**: 自写 tiled TIFF 编码器 (PlanarConfig=2 平面分离, 兼容 GDAL/QGIS/geotiff.js)
- **可移植性**: 统计管线**不依赖 `shader-f32` 原子特性**, 用 u32 高低位模拟 64 位定点原子加,
  在所有 WebGPU 设备 (含无该特性的集显/headless) 上均可运行

## 九个功能模块对应实现

| 需求 | 实现位置 |
| --- | --- |
| 1. 五波段 GeoTIFF 分块读 + 自建金字塔 + 按需加载 | `src/io/geotiff-reader.ts`, `pyramid.ts`, `importer.ts`, `viewer/camera.ts` |
| 2. 每飞行日定标系数, 未定标阻止下游计算 | `core/calibration.ts`, `pages/ImagesPage.tsx` (定标门控) |
| 3. 表达式编译为着色器, 内置 NDVI/NDRE/GNDVI 等 | `core/expression.ts` (同一 AST 同时生成 WGSL 与 CPU 求值函数) |
| 4. 参数化小区网格, 旋转, 行列微调, 设计表导入 | `core/geometry.ts`, `pages/GridPage.tsx` |
| 5. 内缩去边行 + 土壤阈值剔除 + GPU 一趟统计 | `gpu/stats-pipeline.ts`, 空间哈希定位 + 定点累加 + 自适应直方图 |
| 6. 品系/重复/对照, RCBD 设计表, 对照标色 | `db/idb.ts` (designs), `pages/GridPage.tsx`, `viewer/OverlayCanvas.tsx` |
| 7. 云影自动标记, 标记小区不参与汇总 | `gpu` 掩膜分支 + `PlotStats.flagged`, 统计/时序均过滤 |
| 8. 多期叠加 + GCP 仿射配准 + 时序曲线 + 抽穗期 | `pages/TimeSeriesPage.tsx`, `core/geometry.ts` (fitAffine), `core/stats.ts` (estimateHeadingDate) |
| 9. 单因素方差分析 + 育种家用导出表 | `core/stats.ts` (正则化 Beta 函数实现精确 p 值), `pages/StatsPage.tsx` |

## 精度保证 (核心)

GPU 与 **CPU 逐像素参考实现** (`core/stats.ts -> computePlotStatsCpu`) 共享同一表达式语义
(同一 AST 生成的 WGSL 与 JS 求值函数, safeDiv 除零规则一致)。浏览器自检实测:

- 均值最大相对误差 **0.000002%**
- 中位数最大相对误差 **0.095%** (门限 0.1%)
- 像素计数 GPU/CPU 零差异
- 8000 小区一趟统计 **~1.1 s** (headless 软件渲染; 独立显卡显著更快, 门限 3 s)
- 三景大图来回切换, RAM/显存峰值均低于设定硬预算

## 常用命令

```bash
npm install
npm run dev          # 开发服务器
npm run build        # 类型检查 + 生产构建
npm run test:node    # 37 个纯逻辑单测 (表达式/几何/统计/定标/TIFF 往返/合成影像)
npm run test:browser # Playwright + 真实 WebGPU 端到端验收 (精度/性能/内存/渲染)
```

## 浏览器内手动验收路径

1. 打开应用 → 「试验列表」→ 点击「一键生成演示数据集」
   (生成 3 个飞行日期的 2048×2048 五波段合成影像, 含定标板/云影/行播纹理/走道,
   自动拟合定标系数、RCBD 设计表和小区网格)
2. 「影像浏览」: 缩放平移、切换指数 (表达式实时编译着色器)、查看云影掩膜、色带拉伸
3. 「小区网格」: 调参数/旋转/单行单列微调, 导入设计表 CSV
4. 「表型统计」: 选影像与指数 → GPU 统计 → 「CPU 参考校验」看相对误差 → 方差分析 → 导出 CSV
5. 「时序对比」: 添加控制点拟合仿射配准, 查看指数曲线与抽穗期拐点估计
6. 「系统自检」: 一键运行全套 WebGPU 验收, 结果写入 `test-results/selftest.json`

## 目录结构

```
src/
  core/      纯算法: 表达式编译器, 几何/仿射, 定标, 统计/ANOVA, 色带
  gpu/       WebGPU 管线: 统计/直方图/渲染/设备/纹理缓存
  io/        TIFF 编解码, 金字塔, 合成影像, 栅格服务, 缓存
  db/        IndexedDB schema 与访问层
  app/       React 页面, 查看器 (相机/画布/覆盖层), 状态, 浏览器自检
test/        Vitest 单测
scripts/     Playwright 浏览器自检驱动
```
