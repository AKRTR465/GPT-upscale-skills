# 示例与来源 / Examples and provenance

这些文件由仓库维护者从此前已完成的制作任务中指定，展示本 skill 所总结的工作流。它们不是本仓库新辅助脚本的重跑结果；本仓库测试使用独立的合成几何图，不会调用图像模型。

These files were selected by the repository maintainer from completed work using the original workflow. They are not fresh outputs of the generalized helper in this repository. Functional tests use separate synthetic geometry and make no image-generation calls.

## 完整图 / Full images

| Before | After |
|---|---|
| [![原图完整预览](before-preview.jpg)](before.png) | [![重绘后完整预览](after-preview.jpg)](after.png) |

- **[before.png](before.png)** — 1445×720. Corresponding source `95016f8defd621f7c4fcf876b9d0f7438de939c1.jpg`, converted to PNG with EXIF direction normalization and sRGB interpretation. Native dimensions and full composition are retained; it is not artificially enlarged.
- **[after.png](after.png)** — 7680×3827. Exact copy of the user-selected `绯红魔女-8k.png` (about 57.5 MiB). Full resolution and composition are retained. This is the version preserving the source's lower-left signature, not the subsequent removal version.
- The JPEG previews show the complete composition at comparable displayed size. Click to open the full PNG files.
- Original processing record: 4×3 tiles with 448-pixel overlap; 11 generative tile redraws, one conservative source-based repair, and one independent face edit. The retained tile was not generated after the editor rejected it. This example must not be described as 12 successful generative tile edits.

## 局部对比 / Detail comparisons

| File | Dimensions | Meaning |
|---|---|---|
| [starry-detail-comparison.png](starry-detail-comparison.png) | 2312×1044 | Four pairs of detail crops: each pair compares the enlarged source on the left with the locally redrawn result on the right. |
| [forest-portrait1-comparison.png](forest-portrait1-comparison.png) | 1416×958 | Matching portrait-group crop: source-based view left, local reconstruction right. Both were resized to the same presentation width when the comparison was originally made. |

两张局部对比图按用户指定文件逐字节复制，没有重新裁剪、压缩或生成。“同尺寸对比”指对比面板使用相同显示比例，不表示输入图和输出图原生分辨率相同。面板里的“8K”指原任务交付画布，不能据此推断模型原生输出尺寸。

Both comparison PNGs are byte-for-byte copies of the selected artifacts. Matching presentation size does not imply matching native source/output resolution. Any "8K" label refers to the original task's delivery canvas, not a verified native model-output size.

The complete file sizes, dimensions and SHA-256 values are in [provenance.json](provenance.json). Machine-specific paths and conversation logs are not included.

## 图片权利 / Image rights

本仓库的 MIT 许可适用于代码和文档，不授予示例原画、角色或衍生对比图的再许可权。相关权利归各自原权利人。现有制作记录没有完整作者和原始发布链接，因此不在此推测作者或声称这些图片为开源素材。

The MIT license applies to code and documentation. It does not license the underlying example artwork, characters, or derivative image comparisons. Rights remain with their respective rights holders. Complete author attribution and original publication links were not available in the supplied processing records; this repository does not invent attribution or represent these images as open-source artwork.
