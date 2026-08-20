# @deepseek-ai/dsh-ocr-preprocess

[English](README.md) | 中文

面向纯文本模型的可选 OCR 预处理插件。当一条已认领的用户消息包含图片内容、而将要处理该请求的模型不接受图片时，插件会把每张图片发送给配置好的 OCR 模型，并用识别出的文本替换消息中的图片。OCR 调用会以持久的 `session/ocr-request` 事件写入会话日志，其中携带图片引用，因此 UI 仍能渲染原始附件，整个转换过程也可以从日志中重建。默认组合中不启用。

## 配置

```yaml
- id: ocr-preprocess
  name: '@deepseek-ai/dsh-ocr-preprocess'
  config:
    provider: lmstudio      # registered provider route of the OCR model
    model: ovisocr2         # provider-owned OCR model id
```

组合条目要求 `provider` 与 `model`。运行时可通过 `ocr-preprocess` 设置命名空间覆盖路由，该命名空间还接受可选的 `prompt`（OCR 指令）、`maxTokens`（输出 token 上限，默认 2048）与 `timeoutMs`（端到端超时，默认 60000）。

## 行为

插件在 `agent/pre-step` 上注册了一个 prepend 监听器并先委托给下游。当下游决策进入后，插件检查每条含图片内容的已认领用户消息：它通过 `ctx.llm.resolveModelInfo` 解析将要处理该请求的模型（优先取最近的 `request/header` 配置，回退到 agent options），如果该模型声明支持图片输入则保持消息不变；否则每个图片块都会被发送给配置的 OCR 模型，识别出的文本以 `[OCR of attached image]` 前缀替换图片。空 OCR 结果会变成 `[OCR of attached image: no text recognized]`。

调用前会追加一条 `session/ocr-request` 事件，记录精确的消息 id、图片引用、提示词、路由与 token 上限，并附带 `rawOutput` 以便无密钥回放能够重建该辅助调用。重写后的消息正是循环追加为 `user/message` 并派生进模型历史的内容，因此 OCR 文本是持久且可重建的。`./invariant` 伴生插件校验记录的输入侧、`rawOutput` 的存在性，以及每条 OCR 记录都被其用户消息应答的关系。

只要配置了路由，`ctx.ocrPreprocess.handlesImages()` 就返回 true。Web host 与 ACP 的图片准入门都会查询该值：启用 OCR 预处理后，纯文本模型可以被选中并接受内联图片，因为这些图片会在主模型看到之前被转换。pre-step 的模型能力检查与 read_image 路由门一样，会与并发的模型切换存在竞态；Web host 的图片感知切换守卫覆盖该场景。

## 模型体验

### 面向纯文本模型的图片消息自动 OCR

#### 模型看到什么

图片块会被替换为以 `[OCR of attached image]` 开头、后接识别文本的文本块。在纯文本路由上模型永远收不到原始图片；当服务模型支持图片时，消息原样通过。OCR 调用本身是一次辅助 LLM 调用，只能通过日志中的 `session/ocr-request` 记录观察到。

#### Token 影响

每张被识别的图片都会向请求中加入 OCR 输出文本。辅助 OCR 调用在 OCR 路由上消耗最多 `maxTokens` 的输出 token，与主模型的预算相互独立。

#### KV 缓存影响

只追加；重写后的消息占据原用户消息的位置，因此其前的请求前缀不变，已有的 KV 缓存条目仍然可复用。

## 已知限制与待办

- **不对历史做 OCR** — 只有新认领的用户消息会被转换。已存在于持久历史中的图片（在启用插件之前被准入，或在支持图片的路由下产生）会原样到达模型。
- **路由解析存在竞态** — pre-step 的能力检查使用最近的请求头，回退到 agent options；在 pre-step 与 `agent/request` 之间切换模型时，可能有一个步骤按旧路由的决策处理。
- **OCR 失败会使步骤失败** — 失败、超时或非文本的 OCR 调用会抛出明确的 `LlmError` 并中止该轮，而不是静默丢弃图片。
- **OCR 结果只能是文本** — 插件从不转发非文本的 OCR 输出；如果模型在 OCR 路由上输出工具调用或图片，该步骤会被拒绝。
