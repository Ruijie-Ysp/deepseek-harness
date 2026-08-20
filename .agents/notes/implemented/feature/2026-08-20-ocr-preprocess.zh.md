# Agent Note：图片消息的自动 OCR 预处理

状态：已实现

[English](2026-08-20-ocr-preprocess.md) | 中文

## 问题

纯文本模型无法直接接收原始图片，因此发送图片必须先将会话切换到支持图片的模型。Web host 会拒绝向纯文本路由准入图片，也会在会话仍含图片时拒绝切换到纯文本模型。用户希望使用本地 OCR 模型时，由 harness 自动运行 OCR 并将识别文本转发给 DeepSeek，同时在对话中保留图片缩略图，而无需手动切换模型。

## 决策

`@deepseek-ai/dsh-ocr-preprocess` 是位于 `packages/context/ocr-preprocess/` 的可选服务插件。默认组合不启用。组合条目要求 `provider` 与 `model` 指定 OCR 路由；`ocr-preprocess` 设置命名空间可在运行时覆盖路由，并可选提供 `prompt`、`maxTokens` 与 `timeoutMs`。

插件在 `agent/pre-step` 上注册 prepend 监听器并先委托给下游。当下游决策进入后，检查每条含图片内容的已认领用户消息：通过 `ctx.llm.resolveModelInfo` 解析将要处理该请求的模型（优先取最近的 `request/header` 配置，回退到 agent options）。声明支持图片输入的模型会让消息原样通过；否则每个图片块都会通过 `ctx.llm.stream` 发送给配置的 OCR 模型，识别出的文本以 `[OCR of attached image]` 前缀替换图片。空 OCR 结果变成 `[OCR of attached image: no text recognized]`。失败、超时或非文本的 OCR 调用会抛出明确的 `LlmError` 并中止该轮。

调用前会追加一条 `session/ocr-request` 事件，记录精确的消息 id、图片引用、提示词、路由、token 上限与 `rawOutput`（完整 OCR 文本块）。重写后的消息正是循环追加为 `user/message` 并派生进模型历史的内容，因此 OCR 文本持久且可重建——模型可见内容始终有日志记录。`./invariant` 伴生插件校验记录输入侧、`rawOutput` 以及每条 OCR 记录都被其用户消息应答的关系。

`session/ocr-request` 事件声明在 `SessionEventMap` 中，并重新生成进 `known-event-types` 与持久化目录，因此持久化与回放将其视为一等日志记录。`llm-replay` 从 `rawOutput` 为辅助 OCR 调用派生回放条目，使无密钥快照能够完整回放整个转换过程。

只要配置了路由，`ctx.ocrPreprocess.handlesImages()` 就返回 true。Web host 准入（api-proxy 的 `selectModel` 与 `prompt`）以及 ACP 内联图片准入都会查询该值：启用 OCR 预处理后，纯文本模型可以被选中并接受图片，因为这些图片会在主模型看到之前被转换。`supportsAcpImagePrompts` 同样会在 OCR 预处理接管图片时声明支持内联图片提示。

客户端从 `session/ocr-request` 事件中读取原始附件并渲染在重写后的消息旁，从而在对话中保留图片缩略图（用户明确的选择），而模型只看到识别出的文本。

## 备选方案

- **在日志消息中保留图片、请求时再剥离** — 已否决：agent-loop 不变量要求请求消息与派生的持久历史一致，图片必须离开日志消息。
- **仅在 Web host 中运行 OCR** — 已否决：该能力应位于与传输无关的 `agent/pre-step` 接缝上，使 headless、ACP 与 Web 部署共享。
- **无论服务模型如何都对所有图片做 OCR** — 已否决：按用户的选择，支持图片的模型应原样接收原始图片。
- **静默丢弃图片** — 已否决：用户选择保留缩略图；`session/ocr-request` 事件为 UI 保留了附件。

## 验证

包测试覆盖纯文本路由的 pre-step 重写、支持图片时的原样通过、未知路由回退、空与非文本 OCR 输出、max-token 与上游失败、设置覆盖与 `handlesImages`。不变量测试套件校验记录输入侧与记录到消息的关系。一个真实的 Loader 组合通过确定性双路由适配器启动 headless agent 下的 `ocr-preprocess.cordis.yml`，并断言持久日志包含 OCR 记录、重写后的消息且不含原始图片。无密钥 ACP 快照 `ocr-preprocess` 在纯文本路由上发送内联图片，同时回放 OCR 调用与主调用，并固定持久日志与 stdout 转录。

## 影响

- 挂载 OCR 预处理后，纯文本模型可以接受图片，无需切换模型或改动会话头。
- OCR 文本模型可见且有日志；原始图片引用保留在 `session/ocr-request` 事件中，供 UI 渲染与回放使用。
- 辅助 OCR 调用可从日志重建并可无密钥回放。
- 该能力为可选启用；默认包与组合不会挂载。
