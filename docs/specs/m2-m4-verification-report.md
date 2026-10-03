# M2–M4 统一验收报告（2026-10-02）

历史验收记录，当前任务与状态见 [ROADMAP](../ROADMAP.md)。本文保留当时结果，不代表后续修复已复验。

执行：验收线程（computer use，用户日常 Chrome，真实 key）。测试数据已全部清理
（constraint / constrained / constraints / school 4 条测试词条已删，用户既有
Karpathy / voluntarily 未动）；工具栏固定已还原；key 未读取、未记录。
环境备注：用户 Chrome 内同时装有 Language Reactor 扩展（对 YouTube 显示 LR OFF，
未观察到干扰）；扩展加载的是旧构建，本次验收前已重载至 2026-10-01 构建并确认
「网站访问 = 在所有网站上」。

## 1. 工程回归（自动）

| 项目 | 结果 |
| --- | --- |
| `npm run verify-local` | ✅（全链 exit 0） |
| `npm run regress` | ✅ 91 项 |
| `npm run render-check` | ✅ 30 项（尾行「通过 30，失败 0」） |

## 2. YouTube 真实服务（用户 Chrome + key）

| 验收面 | 结果 | 证据摘要 |
| --- | --- | --- |
| §3.1 人工轨道 | ✅ | `arj7oStGLkU`，`data-blc-track=manual`、cues=315；字幕栏英文行 + DeepSeek 中文行（首句「普通学生写论文的时候，」）；进度跳转后英文名行跟随（0:34→0:46→1:00 多次） |
| §3.2 asr 轨道 | ✅ | `Yf6DJmUt1TA`，`track=en(asr)`；播放观察相邻字幕均为完整句、无逐字增长两行；站内从 TED 切入无旧字幕/弹窗残留。⚠️ 观察：`data-blc-count=182` 与 M0 未合并基线相同（见观察项 4） |
| §3.3 查词闭环 | ✅ | 点击字幕词 → 视频暂停 + 弹窗（表达/当前句/`YouTube · 2:15 · en(人工)` 来源行/保存时并提示）；重复保存提示「该上下文已存在，未重复追加」；「已掌握」即时生效；查词暂停后关闭弹窗自动恢复播放；来源链接跳 `&t=136s` 与保存点一致。⚠️ 真实释义间歇性失败（缺陷 1）；同句另一时间保存因 seek 精度（±1s 步进无法稳定落在同一 cue 内）未在真机上复现，去重判定 `isDuplicateVideoContext`（含 startMs）由 regress 91 项覆盖 |
| §3.4 词形 | ✅ | 维基 `Project management` 页：constraints 保存→弹窗词形行 `constrain（动词原形）、constraints（复数）`，侧栏词形关联 chips 出现；查 `constraint` 弹窗词形行虽列出 constraints，保存后保持独立词条（冲突拒绝并入，regress 同款反例）；`constrained` 独立词条；侧栏 × 移除关联可用。⚠️ 查 `constrained` 时弹窗状态 chip 不显示（符合实现：只信模型词形行、无屈折推断；模型未把 constrained 列进 constraints 的词形行） |
| §3.5 跨内容 | ⚠️ | YouTube 侧：`school` 保存后字幕内该词立即带 saved 下划线 ✅。网页侧：正文标记未生效（缺陷 2，SPANS=0），故「字幕词→网页正文标记」「网页词→另一页标记」两条链路被缺陷 2 阻塞；X 选词查词（M1 路径）正常 |
| §3.6 复习 | ✅ | 侧栏复习：首卡挖空 + 进度（1/6）、揭示出答案与释义（无释义时显示「未保存释义」）、下一条、在学/已掌握、删除当前词条后队列即时 6→5 跳条、视频来源卡「返回来源」打开 `arj7oStGLkU&t=136s` |

## 3. 侧栏字幕视图与播放矩阵（§4）

- 字幕视图：全文列表、当前句高亮跟随、点击 2:00 行跳转正确、聚焦侧栏按 J 下一句生效；视频标签切换后列表/控制目标跟随（TED ↔ Peep 多标签隔离，Peep 列表不串入 TED）✅
- 双语开关关闭（字幕栏移除、原生字幕恢复、按钮变「双语关」）再开启恢复 ✅；中译隐/显 ✅；暂停/拖动/全屏（字幕栏与查词弹窗全屏可见、可点词）✅；站内切换视频无旧字幕/译文/弹窗残留 ✅
- 多标签页：侧栏「下一句」只作用于当前显示标签页的视频（TED 跳 2:52，Peep 无动作）✅

## 4. 持久化（§5）与失败归属（§6）

- §5.1 M1 旧收藏（Karpathy@x.com、voluntarily@wikipedia）词条/上下文/状态/时间戳完整可读 ✅
- §5.2 chrome://extensions 关闭再开启扩展后，词条、视频时间上下文（&t=136s）、词形关联、设置均在 ✅
- §5.3 完整重启：执行中 Chrome 实际发生了一次完整重启（进程更换），重开后 5 词条全部仍在（在独立 profile 的正式检查仍按工单由 e2e 覆盖）
- §6 断网/错误 key 弹窗错误行：本次为缺陷 1 的「释义失败：服务响应无法解析」形态，保存不受影响 ✅；无字幕视频/空收藏空态由 render-check 覆盖；站内快速切换旧响应不覆盖已验（切 Yf6DJmUt1TA 无 TED 字幕闪现）✅
- storage 探针（`blc-probe-storage` → denied）未在真机执行（e2e 已覆盖）

## 5. 缺陷清单

### 缺陷 1（P1）：deepseek-flash 返回空 content → 释义/字幕翻译间歇性失败

- 文件：`lib/deepseek.ts`（`chat()` 响应解析 + `MODEL`/`MAX_TOKENS` 常量）
- 复现：用户 Chrome（key 有效）→ 任意查词或字幕翻译 → 弹窗显示「释义失败：服务响应无法解析」/字幕栏缺译文行；重试多次成功一次后再次失败（间歇性）
- 证据：SW DevTools Network 显示每次请求 HTTP 200、1–3s、1.2–2.9kB；控制台抓取响应体：`choices[0].message.content=""`，实际回答全在 `reasoning_content`（deepseek-flash 为推理模型，推理链耗尽 `MAX_TOKENS=500`（查词）/`1200`（翻译）后 content 为空）；`chat()` 只读 `content` → `bad-response`
- 期望：稳定取到释义/译文。方向（供修复参考）：换非推理模型或放宽/分离 max_tokens，或 content 为空时回退读 reasoning_content；另建议失败时打一条 log 便于定位（当前失败静默，只有 30s 退避）
- 备注：首句翻译曾成功，证明 key/endpoint/消息链路本身通

### 缺陷 2（P1）：网页正文标记不生效（`span[data-blc-key]` 恒为 0）

- 文件：`entrypoints/web.content.ts` + `shared/marker.ts`（启动链）`entrypoints/background.ts`（`vocabIndex`/`getSettings`）
- 复现：保存任意词条 → 刷新任意网页（维基百科正文含该词）→ 控制台 `document.querySelectorAll('span[data-blc-key]').length === 0`；`data-blc-web=1`、`#blc-mark-style` 已注入；IndexedDB 中词条存在（SW 直读 6 条、forms 正确）；显式写 `markingEnabled=true` 并向页面广播 `settings-changed` / `vocab-changed` 后仍为 0
- 已排除：数据缺失、开关默认值、消息校验入口、词形正则（YouTube 字幕内同套 `buildSurfaceStatusMap` 标记正常）
- 期望：已存词在正文中按状态标出（网页 / X）
- 备注：与缺陷 1 无关（标记不调 AI）；建议在 `reloadAndMark`/`vocabIndex` 消息链路加 log 定位

### 缺陷 3（P3，噪音）：扩展禁用/重载时旧 content script 抛 "Extension context invalidated"

- 复现：chrome://extensions 关闭再开启扩展 → 卡片出现红色「错误」按钮，错误页两条 Uncaught (in promise)，来源 content-scripts/youtube.js
- 影响：无功能影响（属禁用瞬间的预期报错），但错误按钮会误导用户以为扩展故障

### 观察项（不计缺陷）

1. 字幕栏缺失曾复现于本次会话——根因是用户 Chrome 加载的扩展为旧构建，重载后消失；建议发布流程固化「重载后核对徽标/字幕栏」步骤（已在工单 §0.2 有预警）。
2. 用户 Chrome 与 Language Reactor 共存，验证期间 LR 为 OFF；两者同开的相互影响未测。
3. 翻译失败时每标签页每 30s 一次重试，多标签同时播放时 SW 请求量可观（4 分钟约 47 次 completions，含其他 YouTube 标签页各自的重试）；符合设计但缺陷 1 修复后自然消解。
4. asr `data-blc-count=182` 与 M0 未合并基线相同：视觉上无逐字增长行（合并函数在调用链上、首条 cue 已是长句），未证实违规也未证实合并生效，建议在 SW 日志加 merged 前后计数便于下次核验。

## 6. 结论

M2–M4 功能面验收整体通过（工程回归、字幕闭环、查词/保存/去重/回跳、词形关联、
复习、播放矩阵、持久化）。**两个 P1 缺陷阻塞「真实释义稳定可用」与「网页跨内容
标记」两项 PRD 承诺**，建议修复缺陷 1、2 后针对性复验（缺陷 1 复验仅需查词 +
字幕翻译各一次；缺陷 2 复验需网页保存 → 刷新页面 → 标记出现 + 字幕保存 → 网页
标记 + X 时间线滚动标记）。

## 7. 历史基线与后续修复记录

以下 M0 记录从 REFERENCES 移入（2026-10-01，Chrome 154，与 Language Reactor 共存）：

| 视频 | 轨道 | 结果 |
| --- | --- | --- |
| `arj7oStGLkU`（TED, Tim Urban） | en（manual） | 315 条 cue；首条 `[12.64s–14.02s] So in college,`，末条 `[834.63s–842.62s] (Applause)` |
| `_OBlgSz8sSM`（Charlie bit my finger） | en（asr） | 7 条 cue；首条 `[5.44s–9.52s] Charlie Charlie Bit`（首测 nocues，经播放器 API 强制选轨恢复后取得） |
| `Yf6DJmUt1TA`（Peep and the Big Wide World，站内切换到达） | en（asr） | 182 条 cue；首条 `[0.00s–6.28s] The sounds of silence, [music]`；站内两次切换（自动播放 + 点击相关视频）后状态均属新视频，无旧字幕残留 |

原 ROADMAP 的后续修复声明（2026-10-02）：DeepSeek 查词 / 翻译预算调整并对空正文或截断增加一次重试；网页标记改为跨切片保留 TreeWalker 游标；扩展失效时消息发送捕获同步异常。本地检查通过的声明不代表实际网页标记已闭环，后续浏览器结果见 M5 报告第 9 节。
