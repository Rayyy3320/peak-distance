# 来源与复用

## 实现参考

| 来源 | 用途与状态 |
| --- | --- |
| [yt-dual-subs](https://github.com/Gythiro/yt-dual-subs) | 已移植字幕获取、tlang URL 构造及 Google 翻译；Google 已真实验证，真实视频端到端结果见 M6 报告 |
| [Saladict](https://github.com/crimx/ext-saladict) | M6 在线词典候选，尚未移植；参考 [剑桥](https://github.com/crimx/ext-saladict/blob/dev/src/components/dictionaries/cambridge/engine.ts)、[牛津](https://github.com/crimx/ext-saladict/blob/dev/src/components/dictionaries/oaldict/engine.ts)、[有道](https://github.com/crimx/ext-saladict/blob/dev/src/components/dictionaries/youdao/engine.ts) |
| [Language Reactor](https://www.languagereactor.com/) | 产品交互参考；[开发者说明](https://forum.languagelearningwithnetflix.com/t/user-dictionary-syntax/994)确认外部词典 URL 模板，不据此推断内置词典来源 |
| [asbplayer](https://github.com/asbplayer/asbplayer) | 字幕学习与播放交互参考 |
| [WXT](https://wxt.dev/guide/installation.html) | 扩展工程文档 |

## 文档依据

- [OpenAI GPT-6：精简指令与按需上下文](https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra)
- [OpenAI GPT-6：委派与验证范围](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-6-astra)

## M10 删除交互移植

- 作者：Moumen Soliman；组件：[21st.dev / NativeDelete](https://21st.dev/@moumensoliman/components/delete-button)。页面显示发布日期 2026-01-19；发布 commit／不可变源码 revision 未提供，不以预览文件名代替 commit。
- 2026-10-03 用户在本次对话提供完整 `NativeDelete` 组件；仅归档为 [native-delete.tsx.txt](references/native-delete.tsx.txt)，不参与构建。原路径由使用示例指向 `components/ui/delete-button.tsx`；本地 DOM / CSS 实现为 `shared/deleteButton.ts` 与 `shared/deleteButton.css`，复用到历史行删除及清空。
- 依赖 `./button`、`@/lib/utils`、React、Framer Motion 和 Lucide React；用户未提供 Button／主题源码或许可声明。保留用户提供的注释，不推断该组件沿用其他项目的 MIT 许可；本轮按用户指定组件重新实现 DOM 交互，未复制未提供的 Button／主题文件或引入原框架。作者源码发布 commit 与许可声明仍不可得，保留此来源缺口，不声称已取得 MIT 授权。
- [公开演示](https://cdn.21st.dev/moumensoliman/delete-button/default/bundle.1768800782521.html) 已核对 Delete → Confirm＋取消按钮及默认／确认态计算样式；动画数值以用户提供的源码为准。用户授权纸感和红色适配，英文、结构、尺寸与动效保留，详见 [M10 spec](specs/m10-chat-and-popup-interactions.md)。

- 原生动效使用 bounce=0、duration=.35 的临界阻尼响应采样到 Web Animations；图标与文字分别先退出150ms再进入150ms。默认／确认／取消静态样式已对照归档预览，纸感和暖红属于用户授权适配。

## Peak Distance 品牌素材

用户提供的 ChatGPT 生图，原始像素保留，仅移动并重命名；未复制第三方项目图像。

| 原文件 | 本地落点 |
| --- | --- |
| ChatGPT 图像 2026年10月2日 22_50_41.png | [山海插画](../public/brand/mountain-coast.png) |
| ChatGPT 图像 2026年10月2日 22_50_56.png | [纸纹](../public/brand/paper-tile.png) |
| ChatGPT 图像 2026年10月2日 22_52_34.png | [山峰标志](../public/brand/peak-mark.png) |

2026-10-03 生成本地派生素材（未引入第三方图像，脚本 [tools/make-brand-assets.py](../../tools/make-brand-assets.py) 可复现，原图 peak-mark.png 保留）：

- [peak-icon.png](../public/brand/peak-icon.png)：为深色工具栏可见度新增的扩展图标，paper-tile 纸纹底 + 墨灰山形，`#DDD9CF` 轻边框圆角。
- [peak-mark-crop.png](../public/brand/peak-mark-crop.png)：peak-mark 按可见山形（alpha>16 边界加 6px 余量）裁掉四周透明留白与淡晕影的副本；品牌区与问答空态以 `object-fit:contain` 使用，替代原先按 64px 负偏移硬裁导致峰体两侧被切的 CSS。

## 已移植：yt-dual-subs

commit：[5657c8a18ca30c84b5d4662bca58e3e9214ffdff](https://github.com/Gythiro/yt-dual-subs/commit/5657c8a18ca30c84b5d4662bca58e3e9214ffdff)；本地参考副本 `.upstream/yt-dual-subs` 不入库。

| 原文件 | 本地落点 | 范围 |
| --- | --- | --- |
| inject.js | entrypoints/youtube-inject.content.ts、shared/youtube.ts、shared/subtitleTracker.ts | timedtext 捕获、json3 解析、来源身份、播放器字幕恢复；M6 增加 buildUrl 的 fmt/tlang 规则 |
| content.js | entrypoints/youtube.content.ts | CC 驱动、导航清理与消息过期判断 |
| inject.js 协议 | shared/protocol.ts | MAIN / ISOLATED 字幕桥 |

各移植文件头部保留来源。MIT，Copyright (c) 2026 Gythiro：

  > Permission is hereby granted, free of charge, to any person obtaining a copy
  > of this software and associated documentation files (the "Software"), to deal
  > in the Software without restriction, including without limitation the rights
  > to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
  > copies of the Software, and to permit persons to whom the Software is
  > furnished to do so, subject to the following conditions:
  >
  > The above copyright notice and this permission notice shall be included in all
  > copies or substantial portions of the Software.
  >
  > THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
  > IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
  > FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
  > AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
  > LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
  > OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
  > SOFTWARE.

## M6 接入记录

2026-10-02：在隔离的 Chromium MV3（Edge）扩展 service worker 中，以 `dict.youdao.com`、`dictionary.cambridge.org`、`translate.googleapis.com` 的 host permissions 和本机代理发起真实请求；本地来源模块也打包进该 worker 运行了同组样例。另在 Node 执行 `tools/check-online-sources.ts`。官方 Chrome 137+ 已移除命令行 `--load-extension`，本轮隔离命令行测试使用 Edge；产品扩展的完整浏览器验收由集成线程完成。

| 来源 | 样例的实际内容 | 选取与限制 |
| --- | --- | --- |
| 有道 `dict.youdao.com/jsonapi` | run「跑，奔跑」、bank「银行」、went「去，过去（go 的过去式）」、take off「脱下… / 起飞」、in spite of「尽管…」；`a surprisingly good result` 与 `zzzxxyynotaword` 没有 `ec.word` 完整词条 | 主词典；仅接收与查询完整匹配且含中文义项的 `ec.word`。`went` 的 `prototype` 返回 `wend`，与释义提到的 go 不一致，只交付来源候选，不自动归并。原站链接为 `/w/<表达>/`。 |
| 剑桥英汉 `dictionary.cambridge.org` | run「跑，奔跑」、take off「起飞;飞起」、in spite of 在重定向的 spite 页内有完整短语块「尽管;不顾，不管」；自由短语和不存在词返回无完整词条 | 备用词典；解析真实 HTML，必须匹配完整词头或带 something/someone 占位的短语块。受限 / 验证页不可当释义。 |
| 牛津学习词典 | run 页面有英文词条、例句；未见英汉义项 | 只留原站入口，不作为本轮中文备用。 |
| Google 免 key 翻译 `translate.googleapis.com/translate_a/single` | `take off` →「起飞」；`The plane took off.` →「飞机起飞了。」 | 常规翻译；非官方端点，可能受限或返回空 / 部分译文，模块将这些情况作为失败而非永久成功缓存。 |

Google 路径参考 / 移植自 [yt-dual-subs commit 5657c8a](https://github.com/Gythiro/yt-dual-subs/commit/5657c8a18ca30c84b5d4662bca58e3e9214ffdff) 的 `background.js` `gtxFetch`；本地落点 `lib/regularTranslation.ts`。MIT，Copyright (c) 2026 Gythiro；许可全文见上节。词典模块 `lib/onlineDictionary.ts` 按本轮实际响应实现，未复制 Saladict 源码。

M6 产品接入：`entrypoints/youtube-inject.content.ts` 复用同一 commit 的 `inject.js` `buildUrl` 参数规则；中文独立轨道按时间交集对齐，平台配对先按时间匹配再随 ASR 合并转换。对齐与取消实现位于 `shared/cues.ts` 及两个 YouTube 入口。其受控测试与尚未完成的真实视频验证分别记录在 [M6 报告](specs/m6-verification-report.md)。
