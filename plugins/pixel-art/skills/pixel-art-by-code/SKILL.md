---
name: pixel-art-by-code
description: >-
  Draw pixel art by writing code and character grids, then checking the rendered result,
  the way a model that can only output text can draw. Covers sprites, characters and
  portraits with expression variants (blink, talking mouths), icons, items, tiles, UI frames
  and small animations: plan on a grid, write small parts as character grids and big shapes
  as primitives, let algorithms do colour ramps, rim shading, outlines and Bayer dithering,
  render to PNG, upscale, lay out contact sheets and look (or read the image back as text),
  then iterate. Use this skill whenever the user wants pixel art, 像素画, 像素风角色, 立绘,
  表情差分, sprites or sprite sheets, 像素动画, retro or game-style icons, wants a reference
  picture turned into clean pixel art, or wants expressions or frames added to existing
  sprites, even if they never say "pixel art" but want small, crisp retro images made
  without an image-generation model.
---

# 用代码画像素画

你只能输出文字，所以把“画”拆成两半：

- **用文字写出像素**：字符画或绘图代码；
- **看图检查结果**：读取渲染出的 PNG，或者把图打印回字符。

两半接成闭环，反复迭代到满意为止。第一版几乎总有问题（部件重叠、比例不对、没对齐），质量来自迭代次数，而不是第一次的想象。所以要尽早渲染、经常看图。

工具是 `scripts/pixel.js`（Node.js，零依赖），既是绘图库也是命令行工具。最快的上手方式是复制 `scripts/example_character.js`：它画了一个角色的 6 个表情、眨眼和说话差分，以及待机动画，下面的每一步都在里面演示了一遍。

```bash
node scripts/example_character.js out                                # 示例：画 Pip 全套
node scripts/pixel.js sheet out/sheet.png out/pip_*.png --scale 6    # 联系表（所有差分并排）
node scripts/pixel.js view out/pip_happy.png --grid                  # 放大 + 像素网格
node scripts/pixel.js ascii out/pip_happy.png                        # 把图打印成字符
node scripts/pixel.js stats out/*.png                                # 尺寸、颜色数、半透明检查
```

## 工作流程

### 1. 定规格（先写下来）

- **尺寸**：图标 8~16 px，小角色 16~32 px，立绘 64~180 px。越小，造型越要几何化、符号化。
- **光源**：统一从左上方来。同一套作品里所有角色保持一致。
- **调色板**：
  - 每种材质 3~5 阶，用 `P.ramp(base, n)` 生成。它让暗部偏蓝紫、亮部偏黄，比单纯调亮调暗更有质感。
  - 整张图控制在 8~32 色。
  - 描边用偏冷的近黑色，不用纯黑。
- **选造型**：几何化、轮廓鲜明的造型最适合用代码画，例如方块小怪、机器人、星星、物件。复杂的有机造型（动漫人物、头发、写实动物）不要硬画，改用参考图转换，见 `references/reference-images.md`。

### 2. 在格子上规划

动手前先写一份简短的版式说明：画布大小、基线和锚点、对称轴、每个大形体的坐标、五官位置、头身比。

按“单位格”来想（例如身体 12×8 格，每格 2 px），比直接想像素坐标可靠。

对称的东西只设计一半。像素 x 的镜像是 W-1-x；左边宽 w、位于 x 的部件，镜像到 W-x-w。示例里的 `pair()` 就是这样做的。宽度为奇数的部件最容易错一格，要格外注意。

### 3. 写像素

两种写法：

- **字符画**：用于约 24 px 以下的小东西，例如眼睛、嘴、图标、汗滴、星星。每个字符是一个像素，`.` 表示透明：
  ```js
  s.stamp(['.gg.', 'gggg', 'gggg', '.gg.'], { g: '#f2b544' }, 14, 3);   // 4 px 的小圆球
  ```
  4~6 px 的小圆用字符画比用 `ellipse` 好看：ellipse 在这个尺寸会画成方块。
- **几何原语**：用于大形体，带具体数字。常用的有 `fill`、`ellipse`、`poly`、`roundRect`、`line`、`stroke`。

按以下顺序分层。明暗交给算法，不逐个像素决定：

1. **平涂剪影**：只用底色。
2. **打光**：`s.rim(hi, sh, { group })` 把上边和左边缘提亮、下边和右边缘压暗。用 `group` 把不同材质分开。
3. **内部细节**：肚皮、花纹、高光点。要放在打光之后，否则它们会被当成“洞”，周围打上一圈阴影。
4. **描边**：`s.outline(暗色)` 加 1 px 描边。
5. **五官和特效**：放在描边之后画，这样线条保持干净。

半透明和渐变用 Bayer 抖动：`dither`、`ditherEllipse`、`gradient`。不要抗锯齿，透明度只用 0 或 255。

### 4. 差分做成参数

身体只画一次。眼型、嘴型、眉毛、手臂、汗、泪、怒筋、星星做成可替换的部件，一个表情就是一行参数：

```js
const EXPR = {
  happy: { eye: 'happy', mouth: 'open', blush: true },
  sad:   { eye: 'dot', brow: 'sad', mouth: 'frown', tear: true },
};
function sprite(expr, { blink, talk, frame } = {}) { /* 身体 -> 打光 -> 细节 -> 描边 -> 五官 */ }
```

眨眼、口型、动画帧都只是同一个函数的参数。这样所有差分天然同尺寸、同锚点、风格一致。

表情要夸张，多用漫画符号（^ 眼、白眼、汗滴、怒筋、眼泪、星星），在几个像素里也能一眼读出来。

### 5. 渲染并看图（最重要的一步）

每次修改之后：

1. **出图**：用 `P.sheet(items).save(file, { scale: 6 })` 或 `pixel.js sheet` 出联系表，把所有差分并排；用 `pixel.js view --grid` 看单张的细节。
2. **放大再看**：放大 4~12 倍，否则单个像素看不清。也要看一眼原尺寸，那才是真实观感。
3. **写下具体问题**：读图后把问题写成可以执行的修改，例如“左眼高了 1 像素”“肚皮周围出现一圈暗色”“右眼和左眼不对称”。每次只改少量数字，然后重新渲染。
4. **对照检查清单**：
   - 剪影：只看外轮廓，能认出是什么吗？
   - 原尺寸下五官和表情能看清吗？
   - 线条：没有 L 形的双像素台阶、孤立杂点、断开的描边。
   - 差分之间锚点不跳动，对称的部分确实对称。
   - 用 `pixel.js stats` 看颜色数，以及有没有半透明像素。
5. **不能读图时**：用 `pixel.js ascii file.png` 或 `s.ascii()` 把图打印成字符，每个字符一个像素，附颜色图例，可以直接读出轮廓、明暗分区和五官位置。适合 64 px 以内的图，大图用 `--crop x,y,w,h` 看局部。

### 6. 动画

用公式和参数生成每一帧，不要手画：

- 待机：2~8 帧，6 fps，可以做呼吸挤压，让天线、头发等部件滞后一拍。
- 眨眼：随机间隔。
- 口型：每发一个音节切换一次。
- 位移：用缓动函数计算。

`P.gif(file, frames, { fps, scale })` 输出 GIF，`P.strip(frames)` 输出条带图，用来检查跳帧。时序表和公式见 `references/animation.md`。

### 7. 交付

- 1:1 的 PNG（真实像素），加放大预览图和联系表。
- 文件按 `<角色>_<表情>[_talk][_blink][_f<帧号>].png` 命名。
- 把生成脚本一起交出去：以后改一个数字，就能重新生成全套。

## 参考文件（需要时再读）

- `references/craft.md`：像素画手艺细则，包括色阶、描边、打光、抖动、线条、五官与特效的字符画库、小尺寸可读性。
- `references/animation.md`：动画时序表与公式，包括缓动、呼吸、眨眼、口型、跳跃、震动。
- `references/reference-images.md`：把参考图或 AI 生成的“像素风”图转成干净的像素图，包括 `pixel.js pixelate`、手工修整、多帧对齐。
- `references/case-study.md`：实例，介绍一个像素对话游戏里各个角色是怎么画出来的，以及踩过的坑。
- `scripts/pixel.js`：完整 API 写在文件开头的注释里。
