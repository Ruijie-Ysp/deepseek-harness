# OCR Preprocessing

English | [中文](ocr-preprocess.zh.md)

Automatic OCR preprocessing of image messages for text-only models. When a claimed user message contains image content and the model that will serve the request does not accept images, each image is sent to a configured OCR model, and the recognized text replaces the image in the model-visible message. The [ocr-preprocess contract](../../packages/context/ocr-preprocess) owns the settings namespace, the pre-step rewrite, and the durable `session/ocr-request` record; host and ACP admission gates consult `handlesImages()` to admit images for text-only routes.

Sources: [`packages/context/ocr-preprocess/src/types.ts`](../../packages/context/ocr-preprocess/src/types.ts) · [`packages/context/ocr-preprocess/src/index.ts`](../../packages/context/ocr-preprocess/src/index.ts)

## OCR request record

The plugin appends one `session/ocr-request` event before each OCR call. The record carries the exact message id, image refs, prompt, route, token cap, and the complete OCR output blocks so keyless replay can reconstruct the auxiliary call. The `./invariant` companion validates the record input side, the presence of `rawOutput`, and the relation that every OCR record is answered by its user message.

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
