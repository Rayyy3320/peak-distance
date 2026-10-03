# README 视觉素材

两版均以学习流程表达产品，不模拟界面，方便后续 UI 换样式时继续使用。

| 文件 | 用途 |
| --- | --- |
| [hero.png](../hero.png) | README 默认首图；混合排版的静态导出 |
| [hero-layout.svg](hero-layout.svg) | 混合版可编辑排版源；通过相对路径引用项目已有品牌图 |
| [hero.svg](../hero.svg) | 独立纯 SVG 版本，无外部图片、字体或脚本依赖 |
| [render.mjs](render.mjs) | 使用项目已有 Playwright 与本机浏览器重新导出混合版 |

## 内容与视觉依据

- 读者：在网页、X 和 YouTube 中学习英语的个人用户。
- 价值：查词后连同语境保存，并能回到原句复习。
- 示例：正文与纯 SVG 用 `She is comfortable with people.` 说明流程；这是学习示意，不是实时查询或界面截图。
- 首次使用：构建并加载扩展，选词、查词、保存，再到生词本找到原句。
- 配色：米白 `#F7F4EC`、墨灰 `#2F3A40`、雾蓝 `#6B8DB7`、砂金 `#D4A950`、次级灰 `#59636B`。
- 排版：Georgia 英文衬线标题，中文系统衬线标题，系统无衬线流程标签；1200 × 520 画布、64 单位外边距、轻分隔线。
- 素材：复用 [山海插画](../../../public/brand/mountain-coast.png) 与 [纸纹](../../../public/brand/paper-tile.png)，原图未修改。原始来源见 [REFERENCES](../../../docs/REFERENCES.md)。没有重新生图，没有使用旧 UI 测试截图。

## 更新与导出

修改混合版的 `hero-layout.svg` 后，在已安装项目依赖的环境中运行：

```powershell
node assets/readme/source/render.mjs
```

默认使用本机 Windows Edge；可通过 `BLC_CHROME` 指定其它 Chromium 浏览器。导出 `hero.png` 为 2400 × 1040，以保留高像素密度屏幕上的清晰度。字体由导出机器的系统字体决定。

README 发布 PNG；排版源中的相对图片引用仅用于本地编辑与导出。纯 SVG 可以直接嵌入 GitHub，修改后无需导出。两版精确文案分别在源文件中维护。

验证时检查 900px 和 360px 宽度、浅色和深色页面背景，并运行 skill 的 `audit_readme.py`。关键用法保留在 README 正文，图内辅助标签不承担唯一说明。
