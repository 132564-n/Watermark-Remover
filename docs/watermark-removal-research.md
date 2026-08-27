# 图像水印形式、去除方法与纯浏览器实现建议

> 调研日期：2026-08-27  
> 范围：静态图像；重点是可见水印和纯浏览器、内存受限实现。本文只讨论用户有权处理的图像。

## 结论摘要

“去水印”不是一个单一的图像修复问题。至少要先区分两种本质不同的情况：

- **半透明可见水印**仍保留了部分背景信息，正确方向是估计水印颜色与透明度后做逆合成（deblending），而不是把整块区域当作缺失内容重画。
- **完全不透明水印**已经覆盖并丢失原始像素，不存在确定性还原；任何算法只能依据周围内容生成“合理猜测”。这时才应使用 Telea/Navier–Stokes、PatchMatch 或生成式 inpainting。

当前网页最应该采用的结构是：**点击样本 → 多尺度/多角度相似实例识别 → 像素级软掩膜 → 水印类型判断 → 分类型修复 → 仅在掩膜内合成回原图**。不应把分散水印合并后缩放整张图交给一个 512×512 模型，也不应把矩形候选框全部涂抹。

## 1. 水印主要形式

C2PA 规范把可见水印定义为图像内容中人可感知、携带来源信息的部分，把不可见水印定义为以基本不可感知方式写入数字内容、可用于唯一标识或关联清单的信息。这是最上层、最稳定的分类。[C2PA Technical Specification 2.4](https://spec.c2pa.org/specifications/specifications/2.4/specs/C2PA_Specification.html#_watermark)

### 1.1 可见水印

| 维度 | 常见形式 | 信息是否仍在 | 对去除方法的影响 |
|---|---|---:|---|
| 透明度 | 半透明文字、Logo、斜纹 | 部分仍在 | 优先估计 alpha 和水印前景并逆合成；估计失败才局部修复 |
| 透明度 | 完全不透明色块、贴纸、粗字 | 被覆盖部分已丢失 | 只能 inpainting/生成，结果是推测而非恢复 |
| 数量 | 单处 | 缺少同类观测 | 依赖分割模型、人工掩膜或通用修复 |
| 数量 | 重复平铺/斜排 | 多个同模板观测 | 可由一次点击做模板匹配，并用多个实例共同估计 alpha/前景 |
| 内容 | 文字、日期、平台 ID | 笔画细、方向规则 | OCR/连通域/梯度特征有用；应以字形掩膜而非文本外接矩形修复 |
| 内容 | Logo、图章、二维码 | 颜色和形状稳定 | 多通道模板、边缘/形状描述符与局部分割更合适 |
| 几何 | 水平/垂直/固定角度 | 变换较少 | 多尺度模板匹配即可 |
| 几何 | 旋转、缩放、透视、不规则曲线 | 模板会形变 | 需要图像金字塔、角度搜索或局部特征匹配；单模板 NCC 容易漏检 |
| 覆盖 | 小面积、细线 | 邻域约束强 | 快速传播类修复通常够用 |
| 覆盖 | 大面积、跨主体/人脸/文字 | 语义缺失严重 | 生成式模型更可能得到视觉合理结果，但幻觉风险也最高 |
| 变化 | 每处颜色/透明度/形变不同 | 一致性下降 | 要逐实例估计参数，不能共享一个硬阈值掩膜 |

可见水印的“位置、图案、透明度多样”以及同一水印区域内部不同部分外观也可能不同，已被细粒度水印去除研究明确列为核心难点。[Fine-grained Visible Watermark Removal, ICCV 2023](https://openaccess.thecvf.com/content/ICCV2023/html/Niu_Fine-Grained_Visible_Watermark_Removal_ICCV_2023_paper.html)

### 1.2 不可见水印

| 形式 | 写入位置 | 常见目标 | 通用去除是否可验证 |
|---|---|---|---|
| 空域/像素域 | 像素强度或低有效位（LSB 等） | 高容量、脆弱标记 | 没有对应检测器/密钥时通常不能确认是否成功 |
| 变换域 | DCT、DFT、DWT 等系数 | 抗压缩、抗噪、版权标识 | 简单滤波/JPEG 可能只降低而非清除，且会损伤图像 |
| 扩频/量化 | 多个中频系数或感知显著区域 | 鲁棒检测 | 需要针对同步、压缩、几何变换等攻击评估 |
| 学习式像素水印 | 神经编码器写入图像 | AI 内容标识、溯源 | 再生成/扩散攻击可能削弱，但算力高且会改变内容 |
| 语义/潜空间水印 | 生成过程或语义特征 | 期望抵抗像素级攻击 | 不是普通像素滤波能普遍解决的问题 |

经典文献把不可见水印方法概括为空域直接修改像素与变换域修改 DCT/DFT 等系数两大类。[Robust image watermarking in the spatial domain](https://www.sciencedirect.com/science/article/pii/S0165168498000176) DCT 系统的典型做法是在选定 DCT 系数中写入伪随机序列。[A DCT-domain system for robust image watermarking](https://www.sciencedirect.com/science/article/abs/pii/S0165168498000152)

不可见水印的“去除”更准确地说是**让指定检测器解码失败的攻击**。StirMark 基准包含随机几何失真、压缩、滤波等测试，说明不同水印方案必须针对检测器分别评估，不能仅凭肉眼宣布已去除。[StirMark Benchmark 4.0](https://www.petitcolas.net/watermarking/stirmark/) 近年的再生成攻击会先加噪破坏像素水印，再用去噪或生成模型重建；论文报告其对多种像素级方案有效，但它不是轻量浏览器算法，而且会引入内容变化。[Invisible Image Watermarks Are Provably Removable Using Generative AI](https://arxiv.org/abs/2306.01953)

学习式不可见水印之间的检测条件也不同。StegaStamp 把不可见超链接编码进像素，并专门针对打印、拍照等物理扰动训练；Tree-Ring 则把水印写入扩散模型初始噪声的傅里叶空间，并通过反演检测。二者已经说明“不显示字样”并不等于一种统一信号。[StegaStamp, CVPR 2020](https://openaccess.thecvf.com/content_CVPR_2020/html/Tancik_StegaStamp_Invisible_Hyperlinks_in_Physical_Photographs_CVPR_2020_paper.html) [Tree-Ring Watermarks, NeurIPS 2023](https://proceedings.neurips.cc/paper_files/paper/2023/hash/b54d1757c190ba20dbc4f9e4a2f54149-Abstract-Conference.html)

**产品边界建议：**本网页应明确定位为“可见水印/遮挡物修复工具”。除非集成某个具体水印方案的官方检测器并建立攻击前后检测回归，否则不应提供或宣传“通用不可见水印去除”。

## 2. 各类去除与修复方法

### 2.1 已知或可重复估计的半透明水印：逆合成优先

标准 alpha 合成可写为：

```text
I = αW + (1 - α)B
B = (I - αW) / (1 - α)
```

其中 `I` 是观测像素，`W` 是水印前景颜色，`α` 是水印透明度，`B` 是背景。只要 `α < 1` 且 `W、α` 估计准确，就能利用仍然可见的背景，而不是凭空生成。`α` 接近 1 时反演会放大噪声，必须切换到 inpainting。

对于相同水印跨多张图反复出现的情况，CVPR 2017 的工作用广义多图像抠图估计水印前景、alpha matte 和背景，并指出轻微空间形变会明显降低这种恢复质量。[On the Effectiveness of Visible Watermarks, CVPR 2017](https://openaccess.thecvf.com/content_cvpr_2017/html/Dekel_On_the_Effectiveness_CVPR_2017_paper.html) 对本项目的可行推论是：同一张图内存在多个平铺实例时，可以把对齐后的实例块当作小型观测集合，但要给每个实例保留独立的位置、颜色和透明度微调。

WDNet 进一步把可见水印分解为背景、水印、掩膜和透明度，并用第二阶段集中细化水印区域；其 CLWD 数据包含彩色、不同大小/位置/旋转/透明度的水印，透明度训练范围为 0.3–0.7。[WDNet, WACV 2021](https://openaccess.thecvf.com/content/WACV2021/html/Liu_WDNet_Watermark-Decomposition_Network_for_Visible_Watermark_Removal_WACV_2021_paper.html)

**适用：**半透明、颜色/形状稳定、重复文字或 Logo。  
**不适用：**完全不透明、实例严重形变、alpha 接近 1。  
**浏览器实现成本：**低到中；主要是模板对齐、鲁棒统计和逐像素运算，可用 Canvas/ImageData 或 Web Worker。

### 2.2 小而细的遮挡：Telea / Navier–Stokes

OpenCV 的 `inpaint` 提供 Telea 和 Navier–Stokes 两种方法，从掩膜边界邻域向内恢复。官方文档明确其用途包括去除划痕和静态图像中的不需要对象。[OpenCV inpaint](https://docs.opencv.org/4.12.0/d7/d8b/group__photo__inpaint.html) Telea 方法基于快速行进法，目标是把边界颜色和梯度向缺失区域传播，原论文定位就是“小损坏区域”的快速修复。[Telea, An Image Inpainting Technique Based on the Fast Marching Method](https://research.rug.nl/en/publications/an-image-inpainting-technique-based-on-the-fast-marching-method/)

**适用：**细笔画、小 Logo、划痕、近似平坦或缓变背景。  
**弱点：**宽区域、复杂纹理、穿过强边缘时容易拉丝或模糊。  
**浏览器实现成本：**低；可用优先队列+邻域传播的精简实现，或者只加载含 `photo/inpaint` 的 OpenCV.js 定制构建。

### 2.3 重复纹理和局部结构：PatchMatch / exemplar-based completion

PatchMatch 在图像块之间快速寻找近似最近邻，通过传播和随机搜索建立邻域场；论文报告相对当时方法有 20–100 倍加速，并用于交互式图像补全。[PatchMatch, SIGGRAPH 2009](https://gfx.cs.princeton.edu/pubs/Barnes_2009_PAR/index.php) 更早的 exemplar-based 方法已经展示了按结构优先级从源区域复制 patch，可以同时传播线性结构和纹理。[Criminisi et al., Object Removal by Exemplar-Based Inpainting](https://www.microsoft.com/en-us/research/publication/object-removal-by-exemplar-based-inpainting-2/)

**适用：**墙面、地面、天空、布料、规则纹理，且图中存在相似未遮挡区域。  
**弱点：**人脸、文字、独一无二的物体和跨越语义边界的区域；可能复制错误物体。  
**浏览器实现成本：**中；只在候选裁剪块内运行、多尺度 3–5 轮、限制源 patch 不得与掩膜相交，可将内存控制在裁剪尺寸的线性量级。

### 2.4 大面积或完全不透明遮挡：深度生成式 inpainting

LaMa 使用快速傅里叶卷积来扩大有效感受野，目标是对大掩膜和高分辨率图像保持鲁棒性；官方实现和模型见 [advimman/lama](https://github.com/advimman/lama)。OpenCV Zoo 也提供官方 LaMa inpainting 模型说明和示例。[OpenCV Zoo LaMa](https://github.com/opencv/opencv_zoo/tree/main/models/inpainting_lama)

**适用：**大块不透明遮挡、缺失区域需要语义补全、传统方法明显失败。  
**弱点：**输出是视觉猜测；可能产生黑块、错误文字/物体、纹理突变。把整图或多个相距很远的掩膜压缩到 512×512 会丢失细节。模型训练分布也会限制泛化；例如 SLBR 官方仓库明确提示，其训练输入为 256×256，自定义数据最好再微调。[SLBR official repository](https://github.com/bcmi/SLBR-Visible-Watermark-Removal)

**正确合成方式：**逐个连通区域取带上下文的正方形 crop，适当扩张掩膜后推理，再只把软掩膜内部结果合成回原图。CVPR 2026 workshop 的 MorphoMod 也采用“分割 → 掩膜细化/膨胀 → inpaint → 用原图背景恢复掩膜外区域”的流程，说明掩膜与最终合成对结果至关重要。[MorphoMod, CVPRW 2026](https://openaccess.thecvf.com/content/CVPR2026W/SAFE/papers/Robinette_MorphoMod_Visible_Watermark_Removal_with_Morphological_Dilation_CVPRW_2026_paper.pdf)

### 2.5 多张同场景图或视频：时空信息恢复

如果有同场景连拍、视频相邻帧或无水印版本，应优先做配准后从其他帧/图片复制真实像素，并使用 Poisson/梯度域融合消除接缝。这类方法通常比单图生成更可信，但当前网页只有单张输入，不能假设存在额外观测。

## 3. 面向当前网页的推荐算法路由

### 3.1 点击并自动识别相似水印

1. 用户点击水印实例，取一个紧凑模板；模板大小应由局部连通域/边缘范围决定，而不是固定大矩形。
2. 建立 0.75–1.35 倍图像金字塔并搜索有限角度（例如种子角度 ±8°）；使用带掩膜的零均值归一化互相关（masked ZNCC）比较梯度和颜色中性度，也可对边缘距离图计算 Chamfer 分数。CVPR 2017 多图水印工作实际使用了边缘与 Chamfer 匹配；OpenCV 官方模板匹配接口也明确支持给模板提供 mask，其归一化相关公式可作为实现核对基线。[On the Effectiveness of Visible Watermarks, CVPR 2017](https://openaccess.thecvf.com/content_cvpr_2017/papers/Dekel_On_the_Effectiveness_CVPR_2017_paper.pdf) [OpenCV Template Matching](https://docs.opencv.org/4.x/de/da9/tutorial_template_matching.html)
3. 对每个粗候选做 1 px 亚窗口位置细化、尺度/角度细化。
4. 用非极大值抑制合并重叠候选；候选必须同时通过外观分数、前景中性/色彩一致性和逆合成残差检查。
5. 每个候选保留独立软掩膜。点击已选候选时只切换该实例，不影响其他候选。

为什么不能只看灰度相关：海报中的白字、金色高光和斜向边缘会与浅色水印模板产生伪匹配。梯度方向、颜色、alpha 合成一致性和几何约束必须共同投票。

### 3.2 像素级水印掩膜

候选框只负责定位，不能直接作为修复区域。应在候选内部：

- 先按种子实例估计前景色/颜色范围和笔画梯度；
- 多实例对齐后，用鲁棒中位数或分位数估计共同水印分量；
- 生成 0–1 的软 alpha mask，并去掉孤立小连通域；
- 对硬遮挡分支做 1–3 px 膨胀覆盖抗锯齿边缘，再做 1–2 px 羽化；
- 始终保存原始像素，并保证掩膜外逐字节不变。

### 3.3 修复路由判定

| 判定 | 首选 | 失败后的降级 |
|---|---|---|
| 重复实例 ≥3、alpha 稳定且 `<0.85` | 多实例估计 + 逆 alpha 合成 | 小掩膜传统 inpaint |
| 掩膜细、宽度小于约 8 px | Telea/方向传播 | 小裁剪 LaMa |
| 局部纹理重复且 patch 可匹配 | 多尺度 PatchMatch | LaMa |
| 完全不透明、面积大或跨复杂结构 | 单连通区 LaMa crop | 让用户缩小/拆分掩膜重试 |
| 人脸、文字、二维码等高风险语义 | 默认提示“结果为推测”，提供原图对比 | 保留人工调整/撤销 |

阈值不能作为绝对常数；应按图片短边和局部笔画宽度归一化。自动路由还应返回置信度，置信度低时不自动扩大掩膜。

## 4. 纯浏览器与内存受限实现

ONNX Runtime Web 官方支持 WASM、WebGPU、WebGL 和 WebNN；WASM 支持全部 ONNX 算子，而 GPU 后端只支持算子子集。官方建议 Web 场景选择 tiny/small 模型，使用 ORT 格式、自定义裁剪运行时、量化和合适的 execution provider 来降低模型大小、初始化时间和峰值内存。[ONNX Runtime Web](https://onnxruntime.ai/docs/tutorials/web/) [Performance Diagnosis](https://onnxruntime.ai/docs/tutorials/web/performance-diagnosis.html)

当前仓库资源的静态体积（以本地文件为准）：

- `lama_512_int8.onnx`：62,074,990 字节；
- JSEP WASM：21,872,216 字节；
- 运行时 JS/MJS：约 0.45 MB；
- 首次下载合计约 84.4 MB，尚不包括浏览器解码后的模型权重、WASM 堆、输入输出张量和中间激活。

静态下载大小绝不等于推理峰值内存。ONNX Runtime 文档指出，浏览器 ArrayBuffer、protobuf 和 32 位 WebAssembly 都有平台限制，WASM 当前内存上限为 4 GB；低内存设备和嵌入式浏览器往往会更早终止标签页。[Working with Large Models](https://onnxruntime.ai/docs/tutorials/web/large-models.html) WebGPU 同样允许浏览器限制应用可用 GPU 内存，并可因资源分配失败产生 out-of-memory 或 device lost。[W3C WebGPU](https://www.w3.org/TR/webgpu/)

### 4.1 必须采用的资源策略

1. **延迟加载 AI：**页面打开、上传图片、识别水印时都不要加载 ONNX；仅在用户真正执行 AI 修复时初始化。
2. **低成本路径先行：**半透明逆合成、Telea、模板识别不依赖大模型；能解决就不要启动 LaMa。
3. **逐连通区域串行：**同一时刻只保留一个 512 crop 的输入、mask 和输出；完成后释放张量引用，不能并行跑多个区域。
4. **裁剪而非整图缩放：**每个掩膜加 25%–50% 上下文，保持正方形；超大区域分块并重叠融合。
5. **复用单个 session：**一次操作内复用，操作结束或页面进入低内存模式时允许销毁；模型资源使用 HTTP cache/Cache Storage。
6. **Worker 隔离：**WASM 推理放入 Web Worker，避免阻塞 UI；官方 `wasm.proxy` 可改善响应性但不提高推理速度，且不能与 WebGPU EP 同用。[ORT env flags](https://onnxruntime.ai/docs/tutorials/web/env-flags-and-session-options.html)
7. **线程保守：**GitHub Pages 无法为项目页自由配置 COOP/COEP 响应头时，`crossOriginIsolated` 通常为 false，WASM 多线程不会启用；显式回退 `numThreads=1`，避免反复初始化失败。ORT 官方说明多线程要求浏览器支持且开启 cross-origin isolation。
8. **后端分级：**Chrome/Edge 且 WebGPU 可用时尝试 WebGPU；初始化、算子支持或 device-lost 失败时回退 WASM；嵌入式浏览器直接进入“轻量模式”。
9. **失败可恢复：**捕获模型下载、session 初始化、OOM 近似信号和 WebGPU device lost；回退传统修复，并保留原图/掩膜，不能让整个标签页白屏或崩溃。
10. **避免多份整图：**一张 `w×h` RGBA8 图就占 `4wh` 字节。撤销栈应保存压缩 Blob 或差异块，不要长期保留多份 ImageData；处理后及时将临时 canvas 宽高置零以释放 backing store。
11. **选择正确运行时构建：**纯 WASM 路径不应携带 WebGPU/WebNN 才需要的 JSEP 运行时；按 ORT 官方部署矩阵使用 `onnxruntime-web/wasm` 或只包含模型所需算子的定制构建，可减少下载和运行时内存。[Deploying ONNX Runtime Web](https://onnxruntime.ai/docs/tutorials/web/deploy.html)
12. **显式释放原生资源：**不再使用的输出 tensor 调用 `dispose()`，不再使用的 session 调用 `release()`；只删除 JavaScript 数组引用不足以保证 WebGPU/WASM 原生资源立即回收。[ORT WebGPU tensor lifecycle](https://onnxruntime.ai/docs/tutorials/web/ep-webgpu.html) [InferenceSession API](https://onnxruntime.ai/docs/api/js/interfaces/InferenceSession.html)

### 4.2 建议的质量模式

- **轻量模式（默认于内置/移动浏览器）：**模板识别 + 逆合成 + Telea/方向传播；不下载模型。
- **标准模式：**对确实不透明且传统算法失败的连通区域，按需加载量化 LaMa，串行处理。
- **高质量模式：**桌面 WebGPU、充足内存才开放；允许更大 crop、PatchMatch 多尺度和 AI 二次细化。

## 5. 深度模型不能解决的事实

- 不透明水印下的真实内容已经丢失，模型无法“恢复原像素”，只能生成概率上合理的内容。
- 掩膜过宽会删除仍可用的背景，掩膜过窄会留下水印边缘；模型质量不能弥补错误掩膜。
- 512 输入会把大图细字、锐利边缘和纹理下采样；应局部 crop，不能整图压缩。
- 多个远距离区域放入同一 crop 会浪费分辨率并让模型相互影响；应按连通域串行。
- 训练数据域不同会产生明显泛化问题；彩色、旋转、半透明、中文水印与通用对象移除不是同一分布。
- PSNR/SSIM 不能独自证明视觉正确；水印区域 RMSE、掩膜外不变率、边缘保留、感知指标与人工对比都需要。

## 6. 实现与测试优先级

### P0：先修复稳定性和错误破坏

- AI 完全延迟加载，嵌入式浏览器默认轻量模式；
- 修复结果只写回像素级软掩膜，掩膜外 100% 保持；
- 每个连通水印单独 crop、串行推理；
- 发生异常时回退轻量修复，页面不崩溃；
- 自动识别结果可以逐个取消。

### P1：提升当前重复半透明文字效果

- masked ZNCC 的尺度/角度搜索；
- 多实例联合估计水印颜色与 alpha；
- 逆合成恢复半透明水印，alpha 高或残差大的像素再局部 inpaint；
- 候选分数加入反合成一致性，减少海报白字/高光误检。

### P2：补齐水印类型路由

- 小掩膜 Telea；
- 重复纹理 PatchMatch；
- 大而不透明区域才使用 LaMa；
- 低置信度候选让用户确认，不自动修复。

### 必须通过的回归测试

1. 半透明重复斜文字：对干净合成图比较恢复前后水印区域 RMSE；修复后应显著下降。
2. 不透明小文字：Telea 路径，验证边缘连续性且没有矩形模糊块。
3. 纹理背景水印：PatchMatch 路径，检查局部纹理频谱/边缘保留。
4. 复杂海报：确保红字、金色礼盒等非水印高对比元素不被自动选中。
5. 几何变化：同模板不同缩放、角度和透明度；检查召回率、精确率及取消选择。
6. 大图多区域：串行处理，监控峰值内存，确认不会并发创建多个模型输入。
7. 浏览器降级：WebGPU 初始化失败、WASM 加载失败、模型 404、推理异常都必须回到轻量模式。
8. Chrome/Edge、Android、iOS Safari、Codex 内置浏览器分别执行；内置浏览器页面加载阶段不得下载 ONNX/WASM 大模型。
9. 像素保护：所有测试都断言软掩膜外像素逐字节不变。
10. 真实性说明：完全不透明测试只评估接缝、结构和感知质量，不宣称恢复 ground truth。

## 7. 建议采用的最终产品架构

```text
上传图片
  └─ 点击一个水印实例
       ├─ 多尺度/角度相似识别 + NMS
       ├─ 逐实例软 alpha mask（支持点击取消）
       └─ 类型/置信度路由
            ├─ 半透明重复 → 水印分解 + 逆 alpha 合成
            ├─ 小而细 → Telea/方向传播
            ├─ 重复纹理 → crop 内 PatchMatch
            └─ 大且不透明 → 延迟加载 LaMa，逐连通区串行
                  └─ 只在软掩膜内融合，异常时回退
```

这套架构的关键不是再换一个更大的通用模型，而是先保住半透明水印下仍存在的信息、把检测框缩成真实字形掩膜，并让每种遮挡走适合自己的恢复路径。这样既直接针对当前“变糊/黑块/页面崩溃”的原因，也符合纯浏览器的资源边界。
