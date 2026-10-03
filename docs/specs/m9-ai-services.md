# M9：AI 服务配置

## 交付边界

- 服务商预设：DeepSeek、OpenAI、Anthropic、Gemini、GLM、Kimi。预设选择后填写 Key，点击“保存并使用”；高级设置提供协议、Base URL、模型，自定义服务使用相同表单。
- 支持 OpenAI Chat Completions、Anthropic Messages、Gemini generateContent / streamGenerateContent。只处理当前产品使用的纯文本消息与回答，不宣称支持所有供应商的专有扩展或仅 Responses 接口的模型。
- 各服务配置分开持久化；旧 `deepseekApiKey` 在未建立新配置时继续读取，首次保存纳入 DeepSeek 配置，清除 DeepSeek Key 同时清除旧字段。
- 新地址只申请对应 HTTPS 域名权限；失败不替换活动服务，保留输入。地址／协议变更不自动复用原 Key。
- 解释、字幕和问答共用活动配置；每个已开始请求固定配置快照。缓存区分服务、协议、地址、模型；AI 字幕收到配置变化后取消旧请求、清理译文与失败状态，重取当前窗口。

## 检查

- `npm run typecheck`、`npm run build`、`npm run regress`。
- 构建后 `npm run check-ai`：协议请求／响应、分块 SSE、空白增量、错误、凭据归属、旧配置、保存读回、拒绝权限、自定义服务与三类 AI 功能。
- `npm run render-check`：包括服务切换后的字幕刷新；`npm run check-m8`：工作区与问答状态移交。
- UI 证据与受控结果位于 `.upstream/ai-services/`；未使用用户 Key 实测六家供应商。浏览器权限的允许／拒绝在该专项测试中受控模拟，实际授权由 Chrome 提示完成。

## 官方接口依据

- [OpenAI Chat Completions](https://developers.openai.com/api/reference/resources/chat)、[GPT-4.1 mini](https://developers.openai.com/api/docs/models/gpt-4.1-mini)
- [Anthropic Messages](https://platform.claude.com/docs/en/api/messages/create)、[流式事件](https://platform.claude.com/docs/en/build-with-claude/streaming)、[模型 ID](https://platform.claude.com/docs/en/models/overview)
- [Gemini 内容生成与流式协议](https://ai.google.dev/api/generate-content)
- [DeepSeek](https://api-docs.deepseek.com/)、[GLM 快速开始](https://docs.bigmodel.cn/cn/guide/start/quick-start)、[Kimi Chat Completions](https://platform.kimi.com/docs/api/chat)
- [Chrome 可选权限](https://developer.chrome.com/docs/extensions/reference/api/permissions)

默认模型为核对时的明确模型 ID，可在高级设置修改；不自动追踪“最新模型”。

## 0.4.0 验证记录

- 类型、构建、逻辑回归、多服务专项与字幕渲染检查通过。真实扩展 UI 保存读回、服务与凭据隔离、三种协议的解释／字幕／问答、授权拒绝与旧 Key 清除均通过受控验证。
- 独立复查修复 Gemini 流式空白增量丢失、AI 配置切换后的字幕内存缓存未失效；对应回归检查已加入。
- 工作区整体验证暴露原生侧栏重新激活的时序问题：失活面板仍可接收操作。失活时关闭交互并使过期恢复任务失效，新恢复完成才解锁；固定／浮动切换、草稿、引用、后台生成和设置往返检查通过。
- [专项结果](../../.upstream/ai-services/results.json)、[窄设置](../../.upstream/ai-services/settings-400.png)、[宽设置](../../.upstream/ai-services/settings-800.png)。用户 Chrome 需重载 0.4.0 并刷新网页；预设域名首次保存可能弹出浏览器访问授权。
