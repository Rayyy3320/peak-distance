# 技术边界

桌面 Chrome / Manifest V3，单扩展工程；WXT + TypeScript + DOM/CSS。精确版本、入口与权限以配置为准。

## M11 目标边界（待实施）

- 执行 [多语言与本地学习库 spec](specs/m11-multilingual-local-vault.md)，目标覆盖桌面 Chrome / Edge。下文其余部分描述当前实现；具体交付状态见 ROADMAP。
- 语言身份贯穿选区／轨道、查询、缓存、学习记录和索引；源语言与理解语言独立。词典、免费译文、AI 词义及语境结果分别保留来源。
- 保留 IndexedDB 作为运行副本、索引与待写入队列。连接后的学习文件夹承载共享持久资料；通过用户授权的 File System Access 路径读写，先实测容器、生命周期和跨浏览器行为。
- Markdown 承载可读资料与用户笔记／状态，辅助目录承载必要关联及合并信息。读写限受信任扩展上下文，宿主页面不持有目录句柄；Key、调用授权与服务配置不进入共享库。
- 多语言与库逻辑复用现有消息、请求取消和存储入口；保持单工程，不增加常驻程序、云后端或通用协同编辑框架。类型与格式事实以实施代码为准。

## 代码入口

| 位置 | 职责 |
| --- | --- |
| `entrypoints/web.content.ts` | 网页 / X 选区、正文与帖子材料 |
| `entrypoints/youtube*.content.ts` | MAIN world 字幕获取、隔离世界字幕显示及播放控制 |
| `shared/youtubeWorkspace.ts` | 工作区中的字幕、词语、已保存视图；播放动作交给绑定视频的内容脚本 |
| `shared/floatingPanel.ts`、`lib/panelService.ts` | 页内扩展 iframe 外壳、固定／浮动模式路由与全屏状态移交 |
| `shared/translationPopup.ts`、`shared/settingsView.ts` | 选区翻译浮层与扩展源内的共用设置组件 |
| `shared/tokens.css`、`shared/theme.css` | 跨扩展页面和 Shadow DOM 的视觉变量与基础样式 |
| `shared/lookupPopup.ts`、`shared/marker.ts` | 共用查词弹窗、正文词汇标记 |
| `entrypoints/sidepanel/`、`entrypoints/options/` | 生词本、字幕、复习、问答和设置 |
| `entrypoints/background.ts`、`lib/chatService.ts` | 扩展消息、网络请求与问答生命周期 |
| `lib/db.ts` | 扩展源下的 IndexedDB，集中读写与增量升级 |
| `shared/vocab.ts`、`shared/cues.ts`、`shared/review.ts`、`shared/chat.ts` | 词汇、时间轴、复习、材料与对话纯逻辑 |
| `shared/messages.ts`、`shared/protocol.ts` | 扩展内部消息；YouTube 页面桥协议 |

## 持续约束

- 内容模块提供原文、来源与定位信息；学习数据和 UI 不按网站各建一套。
- 普通联网调用由 background 发起；YouTube 已有页面上下文字幕链路保留在 MAIN world。在线词典返回内容解析后只展示所需字段，不执行远端 HTML / 脚本。
- key 限受信任扩展上下文读取。content script 经消息取得不含凭据的设置。
- 学习数据写入扩展自身 IndexedDB，事务保证词条与上下文一致；旧数据、ID 和已有 key 不因升级丢失。
- 页面 UI 用 Shadow DOM 隔离；视频全屏时挂在可见全屏节点。视频控制绑定 tabId + videoId，过期动作不控制其它页面。
- 材料快照不可变，历史引用绑定原快照和来源。模型材料与系统指令分开；只把有效材料 ID 转为来源链接。
- 网络请求绑定操作身份，取消、切来源或清空后迟到结果不能重新写回。持久化生成状态与活请求区分，worker 重启可恢复记录。
- 类型、数据库版本、预算、超时、缓存键由代码定义；此文不复制字段表或常量。

## 在线服务与问答

- `lib/onlineDictionary.ts`、`lib/regularTranslation.ts` 是来源请求与纯文本解析模块；`lib/lookupService.ts` 顺序路由常规查询。`lib/aiClient.ts` 负责 AI 释义、字幕和流式问答，`lib/aiTransport.ts` 适配三种接口；仅在明确 AI 动作或有效 AI 模式下调用。
- AI 服务预设、字段校验与旧配置读取由 `shared/aiConfig.ts` 定义。每次请求固定配置快照，缓存按服务、协议、地址和模型隔离；配置与 Key 不通过普通设置消息下发。新 API 域名通过可选 host permission 在保存手势中授权，请求拒绝重定向。
- 活动 AI 配置变化广播无凭据事件；YouTube AI 模式取消旧请求并清理内存译文／失败状态，利用原有 epoch 丢弃迟到结果。历史 AI 解释保留原来源，新结果记录服务商与模型。
- `lib/onlineCache.ts` 使用现有 `storage.session` 保存成功结果并共享在途请求，最后一个消费者取消时 abort；容量由 `shared/settings.ts` 与设置页控制。
- YouTube MAIN world 复用携带有效签名的 timedtext 请求，读取中文轨道与平台翻译；隔离世界负责时间对齐后的显示、缺失句回退、模式与取消。成功字幕缓存不随显示开关清空。
- 本视频方式与 AP 通过 `storage.session` 按标签页保存；翻译消息显式携带方式，后台没有全局默认兜底。句子收藏使用独立 `sentences` store，与词汇状态和上下文互不删除。
- 独立会话使用 `conversations`；数据库版本升级时将旧 `chats` 一条迁成一个确定 ID 的会话，保留原 store 作兼容备份。窗口活动会话存在 `storage.session`，来源与草稿不再决定会话主键。
- 材料来源固定在每个快照上；每轮消息关联原快照。无材料请求只携带普通历史，附加材料时另允许该快照对应的历史。
- 词典 / 普通译文与 AI 语境解释分别保存到原上下文。旧 `definition` 作为来源未知的历史语境释义读取；复习不从其它原句借解释。

## 工作区承载与选区翻译

- 原生侧栏和页内浮动面板加载同一 sidepanel 入口，不复制学习数据或问答服务。旧 YouTube 页内固定侧栏由统一工作区替代；播放和字幕采集留在内容模块。
- 页内外壳继续用 Shadow DOM；包含凭据的设置必须运行在扩展源页面上下文，可在页内外壳嵌入复用的扩展资源。宿主页面与内容脚本不获得 key；不向宿主开放通用特权消息代理。
- 嵌入资源仅开放工作区 HTML、构建依赖和品牌资源；上下文绑定使用浏览器提供的发送方身份，校验标签页／视频／窗口归属。
- 显式选区翻译使用独立于词典路由的动作，复用现有翻译服务、取消与缓存能力；不复用会截断表达的查词载荷。保持原文不变，以完整输入区分缓存。
- 工作区视图、滚动位置、复习进度和问答材料分段保存到窗口级 session 快照。`lib/chatWorkspace.ts` 管理临时编辑副本，未发送输入、材料与引用只放在窗口级 `storage.session`，不写入会话库；读活动会话不创建记录。首次发送通过校验后，在同一 IndexedDB 事务提交会话、材料快照、首问和回答占位。后续材料修改也在发送事务提交，历史快照保持不变。
- 新建、切换和关闭以窗口操作身份失效旧响应；发送回执只清除本次已发送的编辑，提交期间新增的内容继续保留。模式移交先准备目标容器，路由激活后才允许它交互；隐藏容器停止写回。真实关闭通过显式入口、匹配外壳身份的顶层承载页卸载和 Chrome `sidePanel.onClosed` 清除临时编辑；iframe 内部文档卸载不承担关闭判定，程序性侧栏关闭携带移交标记。标签隐藏、连接断开及 worker 恢复不承担关闭判定。
- 词卡与选区翻译卡监听卡外 pointerdown，不吞点击、不恢复旧焦点；自有工作区沿现有扩展消息传递带发生时间的关闭意图，避免迟到关闭影响新卡。不读取 iframe 文档。具体生命周期见 [M10](specs/m10-chat-and-popup-interactions.md)。
- 浮动外壳按 Chrome 文档身份定向检查当前 iframe 就绪状态，加载／初始化失败提供明确手动重试，已有窗口临时状态继续恢复。检查不自动重载，诊断只记录必要元数据，不包含凭据、问题或材料。
- 原生侧栏的打开遵守用户手势要求；切换失败保留可用容器。API 可用性按用户 Chrome 验证，不以模拟页面证明支持。

平台依据：[Side Panel API](https://developer.chrome.com/docs/extensions/reference/api/sidePanel)、[扩展存储与嵌入上下文](https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies)。

字幕选区通过 [getComposedRanges](https://developer.mozilla.org/en-US/docs/Web/API/Selection/getComposedRanges) 读取 Shadow DOM 内的真实端点；不以重新限定到宿主后的 `isCollapsed` 判定选区为空。

使用普通模块和实际需要的消息，不增加动态插件安装、依赖注入或通用 agent 框架。
上游移植范围与许可见 [REFERENCES](REFERENCES.md)，实际通过与未通过项见 [M7 验收报告](specs/m7-verification-report.md)。
