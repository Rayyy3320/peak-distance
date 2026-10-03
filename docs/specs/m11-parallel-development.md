# M11 并行开发与开工 Prompt

状态：执行方案，未开工。功能与验收以 [M11 spec](m11-multilingual-local-vault.md) 为准。

## 1. 线程与启动顺序

采用三个执行线程、三个独立工作目录。I 同时承担共享实现与集成。

| 线程 | 职责 | 分支 |
| --- | --- | --- |
| I：共享基础与集成 | 类型、消息、数据库迁移、后台接线、设置与主工作区、最终验收 | codex/m11-integration |
| L：多语言查询与内容 | 免费查询／AI 路由、语言识别与分词、网页／视频交互、局部词卡 | codex/m11-language |
| V：本地学习库 | 目录读写、Markdown 往返、合并、完整聊天序列化和重建 | codex/m11-vault |

启动顺序：

1. **I 建基线 B0**：按用户已选方案，将 D:\Coedx\language 建为独立 Git 仓库，仅提交本项目源码、文档与必要资源；排除构建产物、密钥和真实浏览器数据。保留父目录仓库，不纳入相邻项目。
2. **从 B0 开 L、V worktree**：I 创建指向 B0 的 L、V 分支；用户分别创建基于对应分支的 worktree 聊天。L 验证代表性免费渠道／分词，V 验证目录权限／三方读写。探针只改各自测试文件；I 同时准备共享合同。
3. **I 发布合同基线 C0**：吸收探针结果，提交第 3 节合同及最小兼容实现。L、V 合入同一 C0 后进入主体实现。
4. **三线程并行实现**：I 做共享接线与主 UI；L 做多语言模块；V 先打通单词条往返，再扩展句子／偏好／完整聊天。
5. **I 分批合入**：模块达到各自交付条件即合入，不等待全部完成。共享文件夹纵向用例先跑通，再验完整历史。最终由 I 完成 M11 集成验收。

B0、C0 是提交角色名，开工后由 I 公布实际 SHA；不要将它们当作已有 Git 引用。每个 worktree 从指定提交创建，不能使用工具默认远端分支。

## 2. 唯一写入归属

路径相对各自 worktree 的项目根目录。已有文件按下表归属，未列的已有文件归 I；新增文件在归属目录内自行创建，跨范围新增由 I 指定负责人。

| 负责人 | 可写范围 |
| --- | --- |
| I | shared/vocab.ts、shared/settings.ts、shared/messages.ts、shared/protocol.ts、shared/chat.ts、shared/panel.ts、shared/review.ts；lib/db.ts、lib/chatService.ts、lib/chatWorkspace.ts、lib/panelService.ts；entrypoints/background.ts、entrypoints/sidepanel/**、entrypoints/options/**；shared/settingsView.ts；全局视觉变量；构建／依赖文件、现有共用测试入口与正式文档 |
| L | lib/lookupService.ts、lib/regularTranslation.ts、lib/onlineDictionary.ts、lib/onlineCache.ts、lib/aiClient.ts；entrypoints/web.content.ts、entrypoints/youtube.content.ts、entrypoints/youtube-inject.content.ts；shared/cues.ts、shared/marker.ts、shared/selection.ts、shared/youtubeWorkspace.ts、shared/lookupPopup.ts、shared/translationPopup.ts；tools/m11-language-*；docs/specs/m11-language-results.md |
| V | 新增 lib/vault/**；确有需要时新增 entrypoints/vault-permission/**；tools/m11-vault-*；docs/specs/m11-vault-results.md |

- I 在 C0 中为实际需要的语言定义、规范化和学习库交换类型指定代码落点；共享合同持续归 I，避免两边各建一套。
- lib/db.ts 的语言迁移和库读写适配都由 I 实施。V 通过约定的输入／输出接收数据，不另写数据库迁移。
- background.ts 的网络与文件夹路由由 I 接线；L、V 提供可调用模块，不各自复制消息路由。
- 设置页与主生词本／聊天页归 I；L 只改内容脚本、词卡和视频子视图。全局样式由 I 维护，局部控件复用现有 token。
- 模块负责人完成工作并交付提交后，I 才能接管该批文件修集成问题；仍在开发的文件继续由原负责人修改。
- 涉及他人文件时提交具体接口需求、调用点和必要改动，不越界提交补丁。普通实现选择在归属内自行完成。

## 3. C0 必须确定的合同

用代码类型／函数签名及短交接清单承载；不另建架构框架。

| 合同 | 必须确定 | 使用者 |
| --- | --- | --- |
| 语言与身份 | 源／理解语言、待确认表示、语言代码映射归属、表达规范化、稳定词条 ID 与去重身份 | I、L、V |
| 查询 | 请求携带语言对、原文／语境、请求身份、调用意图与取消；词典／译文／AI 结果及错误分类 | I、L |
| 内容与视图 | 轨道语言、译文语言、词汇索引语言、笔记／状态、语言设置及更新消息 | I、L |
| 学习库交换 | 记录、完整会话／材料输入；读回的变更／删除／冲突；库身份、待写入与提交回执 | I、V |
| 执行归属 | 目录句柄存取上下文、唤醒／重试入口、提交确认、聊天生成归属 | I、V |

C0 保持当前工程可检查；必要时兼容旧调用，新接口不伪造“保存成功”。L／V 等待 C0 期间只完成探针与独立夹具，不按猜测类型扩展主体实现。

合同变更由 I 提交一个小变更并公布 SHA、影响调用点；相关线程合入后继续。未受影响工作继续，不要求全员反复停工。

## 4. 测试、合并与交接

- 每线程使用自己的 .output、浏览器临时配置、测试目录、端口和输出文件。三方同步测试仅在专门的临时学习库中进行；正式用户库不作为夹具。
- L、V 直接运行各自检查脚本，不同时编辑 package.json 或共用回归文件；必要依赖由 I 统一加入并提交锁文件。
- L 的服务覆盖探测不由其它线程重复请求。V 的文件系统探针结果供 I 接线使用；涉及用户实际浏览器的操作集中由 I 安排。
- I 在集成分支逐批合并交付提交；L、V 只同步 I 公布的基线／合同修订，不相互合并，也不改写已交付的提交历史。
- 各线程承担自己的测试。合入后由 I 跑受影响的集成用例；最后执行 M11 要求的完整相关检查。测试失败回到文件负责人修复，交接接管后由 I 修复。
- 模块交付必须可运行并附真实检查结果；测试替身只能证明接口和路由，不能作为真实语言服务／文件系统通过证据。
- 模块结果写入 docs/specs/m11-language-results.md、m11-vault-results.md，分别由 L、V 独占。I 汇总正式 m11-verification-report.md 并更新 ROADMAP。

每次交接只需：基线 SHA、交付 SHA／提交范围、完成的验收编号、已运行检查、未通过项、是否交还文件写入权。

## 5. 开工 Prompt

按第 1 节顺序复制到对应执行聊天；所有路径均相对该聊天获配的工作目录。线程不再递归拆分开发任务。

### I：共享基础与集成

~~~text
你负责 M11 的共享基础实现与集成。

读取 AGENTS.md、docs/ROADMAP.md、docs/specs/m11-multilingual-local-vault.md 和 docs/specs/m11-parallel-development.md；UI 改动按 M11 第 6 节读取现有设计规范。

用户已选择将 D:\Coedx\language 建为独立 Git 仓库。先复核现状：若仍未独立建仓，建立仅包含本项目的仓库和可恢复提交基线，不改动父仓库。检查已有忽略规则，提交源码、文档和必要资源，记录基线检查结果。建立 codex/m11-integration 分支，公布 B0 的实际 SHA。

按并行方案从 B0 准备 L、V 分支，公布基线；用户基于这两个分支创建各自的 worktree 开发聊天。结合两边探针结果，在你负责的文件里实现最小共享合同并公布 C0；未收到探针结果时继续可独立完成的基础工作。

你独占共享类型、IndexedDB 迁移、background 接线、设置和主工作区、依赖与正式文档。L、V 活跃期间遵守写入归属。实现共享代码、接入模块、完成旧数据迁移与最终 UI，并逐批合入交付提交。

共享合同变化由你提交并公布影响点。按 M11 验收矩阵验证合并结果，区分模块测试与端到端通过；普通修复和已授权测试继续完成，只有产品取舍或实际技术阻塞才交回问题。

准备阶段分别输出 B0/C0 SHA、分支、合同位置和可开工范围。最终输出构建、验收结果与剩余限制，更新 M11 报告和 ROADMAP。不要自动新建其它开发聊天。
~~~

### L：多语言查询与内容

~~~text
你负责 M11 的 L 线程：多语言查询与网页／视频内容。

在分配的 codex/m11-language worktree 内工作，报告当前目录并核实基线为 I 公布的 B0。读取 AGENTS.md、docs/specs/m11-multilingual-local-vault.md 和 docs/specs/m11-parallel-development.md；涉及 UI 时遵守 M11 第 6 节的 design.md、M8/M10 与相关视频规范。

先在 tools/m11-language-* 中验证代表性免费渠道、语言代码和分词行为，使用非用户材料；把结果和共享接口需求交给 I。C0 未发布前不按猜测修改产品接口。收到 C0 后合入，再完成归属表内的主体实现。

实现语言对贯穿的词典／免费翻译／AI 路由、缓存与取消，以及网页选区、字幕轨道、分词、标记、词卡和视频子视图。遵守默认免 Key、词典优先、主动开关后才允许查词 AI 兜底；悬停和预取不触发 LLM。

使用 I 提供的语言身份、设置与消息合同。background、数据库、共享类型、主侧栏、设置页、依赖文件由 I 修改；需要变更时给出调用点和明确需求，不另建平行接口。

完成你负责的检查与真实服务覆盖记录，并与 I 集成后的版本复核 L1–L6 及相关 U1 用例。每个可合入批次提交后报告基线和交付 SHA、检查结果、待接线项及文件是否交还 I；未接线通过不能标为完整学习闭环通过。结果写入 docs/specs/m11-language-results.md。
~~~

### V：本地学习库

~~~text
你负责 M11 的 V 线程：本地 Markdown 学习库。

在分配的 codex/m11-vault worktree 内工作，报告当前目录并核实基线为 I 公布的 B0。读取 AGENTS.md、docs/specs/m11-multilingual-local-vault.md 和 docs/specs/m11-parallel-development.md；必要的目录授权页面遵守 M11 第 6 节 UI/UX 规范。

先在 tools/m11-vault-* 中完成目录读写探针：真实 Chrome／Edge 分别授权同一临时目录，验证重启、关闭面板、worker 恢复、Obsidian 修改读回和并发保存。提供实际运行上下文、失败用例与共享接口需求；探针不改用户正式学习库。

收到并合入 I 的 C0 后，在 lib/vault/** 实现目录访问、简单 Markdown 往返、增量读写、必要合并与冲突结果。先交付一个词条的双向编辑，再扩展句子、语言偏好、完整聊天及材料恢复。格式遵守 M11，不增加复杂 frontmatter、全量历史框架或常驻程序。

使用 I 的学习库交换合同；IndexedDB 迁移、background 接线、主 UI 和聊天生命周期由 I 实现。你的模块返回变更、删除、冲突和提交结果，不另写数据库或消息系统。只有探针证明必要时才增加专用目录授权页面。

完成 V1–V5 与 C1/C2 的模块侧检查，和 I 联调后核对真实恢复及并发结果。每个可合入批次提交后报告基线和交付 SHA、检查结果、待接线项及文件是否交还 I。结果写入 docs/specs/m11-vault-results.md；技术阻塞只阻断依赖它的工作，不伪装通过。
~~~

## 6. 官方参考

- [OpenAI：Multi-agent](https://developers.openai.com/api/docs/guides/responses-multi-agent#when-to-use-multi-agent)
- [OpenAI：Worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees)
- [OpenAI：GPT-6 Astra skills and prompts](https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra)
