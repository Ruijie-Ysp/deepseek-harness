# OCR 预处理

[English](ocr-preprocess.md) | 中文

面向纯文本模型的图片消息自动 OCR 预处理。当一条已认领的用户消息包含图片内容、而将要处理该请求的模型不接受图片时，插件会把每张图片发送给配置好的 OCR 模型，并用识别出的文本替换消息中的图片。[ocr-preprocess 契约](../../packages/context/ocr-preprocess) 拥有设置命名空间、pre-step 重写与持久的 `session/ocr-request` 记录；host 与 ACP 准入会查询 `handlesImages()`，以便为纯文本路由准入图片。

来源：[`packages/context/ocr-preprocess/src/types.ts`](../../packages/context/ocr-preprocess/src/types.ts) · [`packages/context/ocr-preprocess/src/index.ts`](../../packages/context/ocr-preprocess/src/index.ts)

## OCR 请求记录

插件在每次 OCR 调用前追加一条 `session/ocr-request` 事件。记录携带精确的消息 id、图片引用、提示词、路由、token 上限，以及完整的 OCR 输出块，使无密钥回放能够重建该辅助调用。`./invariant` 伴生插件校验记录输入侧、`rawOutput` 的存在性，以及每条 OCR 记录都被其用户消息应答的关系。

```ts type-equiv
/** Exact auxiliary call recorded before one OCR dispatch. */
interface SessionOcrRequestEventData {
  /** Durable id of the claimed user message this call rewrote. */
  readonly messageId: string
  /** Image attachment refs OCR'd by this call, in message order. */
  readonly imageRefs: ImageAttachmentRef[]
  /** Exact OCR instruction prompt. */
  readonly prompt: string
  /** Exact auxiliary LLM route. */
  readonly route: { readonly provider: string; readonly model: string }
  /** Exact output-token cap. */
  readonly maxTokens: number
  /** Complete text blocks the OCR model returned, for replay fidelity. */
  readonly rawOutput: readonly ContentBlock[]
}
```

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxocrpreprocess--ocrpreprocess"></a>

### `ctx.ocrPreprocess` — `OcrPreprocess`

Runs the OCR preprocessing pipeline. Mounting the plugin registers a pre-step listener that rewrites image-bearing user messages when the model that will serve the request does not accept images, and exposes handlesImages so host admission gates can admit images for text-only models.

```ts cordis-catalog
/**
 * Whether a usable OCR route is configured, so image admission gates can
 * accept images for text-only models.
 * @returns true when both provider and model are non-empty.
 */
handlesImages(): boolean
```

Source: [`packages/context/ocr-preprocess/src/index.ts:93`](../../packages/context/ocr-preprocess/src/index.ts)
<!-- END GENERATED cordis-surface -->
