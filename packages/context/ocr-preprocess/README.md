# @deepseek-ai/dsh-ocr-preprocess

English | [中文](README.zh.md)

Opt-in OCR preprocessing of image messages for text-only models. When a claimed user message contains image content and the model that will serve the request does not accept images, each image is sent to a configured OCR model, and the recognized text replaces the image in the model-visible message. The OCR call is logged as a durable `session/ocr-request` event carrying the image refs, so the UI can still render the original attachment and the whole transformation is reconstructable from the session log. Default compositions leave it disabled.

## Config

```yaml
- id: ocr-preprocess
  name: '@deepseek-ai/dsh-ocr-preprocess'
  config:
    provider: lmstudio      # registered provider route of the OCR model
    model: ovisocr2         # provider-owned OCR model id
```

The composition entry requires `provider` and `model`. A live settings provider can override the route at runtime through the `ocr-preprocess` settings namespace, which also accepts optional `prompt` (OCR instruction), `maxTokens` (output-token cap, default 2048), and `timeoutMs` (end-to-end deadline, default 60000).

## Behavior

The plugin registers a prepend listener on `agent/pre-step` and delegates first. When the downstream decision enters, each claimed user message with image content is examined: the plugin resolves the model that will serve the request (latest `request/header` config, falling back to agent options) through `ctx.llm.resolveModelInfo`, and leaves the message untouched when that model declares image input. Otherwise every image block is sent to the configured OCR model, and the recognized text replaces the image with the frame `[OCR of attached image]`. An empty OCR result becomes `[OCR of attached image: no text recognized]`.

Before the call, one `session/ocr-request` event is appended with the exact message id, image refs, prompt, route, and token cap — plus `rawOutput` so keyless replay can reconstruct the auxiliary call. The rewritten message is what the loop appends as `user/message` and derives into model history, so the OCR text is durable and reconstructable. The `./invariant` companion validates the record's input side, the presence of `rawOutput`, and the relation that every OCR record is answered by its user message.

While a route is configured, `ctx.ocrPreprocess.handlesImages()` returns true. Web host and ACP image-admission gates consult it: with OCR preprocessing active, a text-only model may be selected and may accept inline images, because they are converted before the main model sees them. The model-capability check at pre-step races a concurrent model switch exactly like the read_image route gate; the Web host's image-aware switch guard covers its surface.

## Model Experience

### Automatic OCR of image messages for text-only models

#### What the model sees

An image block is replaced by a text block prefixed with `[OCR of attached image]`, followed by the recognized text. The model never receives the raw image on a text-only route; when the serving model accepts images, the message passes through unchanged. The OCR call itself is an auxiliary LLM call visible only through the logged `session/ocr-request` record.

#### Token effect

Each recognized image adds the OCR output text to the request. The auxiliary OCR call consumes output tokens up to `maxTokens` on the OCR route, separate from the main model's budget.

#### KV Cache effect

Append-only; the rewritten message occupies the position of the original user message, so the request prefix that precedes it is unchanged and existing KV-cache entries remain reusable.

## Known Limitations and Deferred Work

- **No retroactive OCR** — only newly claimed user messages are converted. Images already in durable history (admitted before the plugin was enabled, or under an image-capable route) reach the model as-is.
- **Route resolution races** — the pre-step capability check uses the latest request header, falling back to agent options; a model switch between pre-step and `agent/request` can produce one step served by the older route's decision.
- **OCR failure fails the step** — a failed, timed-out, or non-text OCR call surfaces a loud `LlmError` and aborts the turn rather than silently dropping the image.
- **OCR result is text only** — the plugin never forwards non-text OCR output; a model that emits tool calls or images on the OCR route rejects the step.
