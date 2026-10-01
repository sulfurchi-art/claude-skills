# sulfurchi-skills

一个 Claude Code 技能合集。目前收录一个技能：

## pixel-art-by-code：用代码画像素画

![Pip 的 6 个表情](assets/pip_expressions.png)
![Pip 的待机动画](assets/pip_idle.gif)

模型只能输出文字，但仍然可以画像素画。做法是把“画”拆成两半：

- **用文字写出像素**：小部件写成字符画，大形体写成几何指令；配色、打光、描边、抖动交给算法统一完成。
- **看图检查结果**：渲染成 PNG，放大、拼成联系表后看图；不能读图时，把图打印回字符来看。

两半接成一个闭环：发现具体问题，改几个数字，再渲染，直到满意。上面的角色 Pip，以及它的表情差分和待机动画，就是用这个技能的示例脚本生成的。

技能内容包括：

| 文件 | 内容 |
|---|---|
| `SKILL.md` | 工作流程：定规格 → 在格子上规划 → 写像素 → 差分参数化 → 看图迭代 → 动画 → 交付 |
| `scripts/pixel.js` | 零依赖的 Node 工具：绘图原语、字符画、打光与描边、Bayer 抖动、PNG 读写、联系表、字符查看、GIF、参考图像素化 |
| `scripts/example_character.js` | 完整示例，也可以作为新角色的模板 |
| `references/` | 手艺细则（含五官和特效的字符画库）、动画时序与公式、参考图转换、实战案例 |

### 安装

**方式一：Claude Code 插件（推荐）**

```bash
claude plugin marketplace add sulfurchi-art/claude-skills
claude plugin install pixel-art@sulfurchi-skills
```

需要像素画时 Claude 会自动使用这个技能，也可以用 `/pixel-art:pixel-art-by-code` 手动调用。

**方式二：直接复制技能文件夹**

把 `plugins/pixel-art/skills/pixel-art-by-code` 复制到下面任一位置：
- `~/.claude/skills/`：个人使用，所有项目都生效；
- `<项目>/.claude/skills/`：只在这个项目里生效。

**方式三：给其他 agent 使用（Codex 等）**

把技能文件夹放进项目，在 `AGENTS.md` 里写一行：“画像素画之前，先读 `<路径>/SKILL.md`”。

运行环境：需要 Node.js 16 或以上版本，没有其他依赖。把 JPEG 参考图转成 PNG 时需要 ffmpeg，这一项可选。

### 快速体验

```bash
cd plugins/pixel-art/skills/pixel-art-by-code
node scripts/example_character.js out                    # 画出 Pip 全套：PNG、联系表、GIF
node scripts/pixel.js ascii out/pip_happy.png            # 把图打印成字符
node scripts/pixel.js view out/pip_happy.png --grid      # 放大，叠加像素网格
node scripts/pixel.js help                               # 全部命令
```

### 目录结构

```
.claude-plugin/marketplace.json        插件市场清单
plugins/pixel-art/
  .claude-plugin/plugin.json           插件清单
  skills/pixel-art-by-code/
    SKILL.md
    scripts/pixel.js
    scripts/example_character.js
    references/craft.md  animation.md  reference-images.md  case-study.md
assets/                                README 中的预览图
```
