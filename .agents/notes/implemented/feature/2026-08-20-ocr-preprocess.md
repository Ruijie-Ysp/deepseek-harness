# Agent Note: Automatic OCR preprocessing of image messages

Status: implemented

English | [中文](2026-08-20-ocr-preprocess.zh.md)

## Problem

A text-only model cannot receive raw images, so sending an image requires switching the session to an image-capable model first. The web host rejects image admission for a text-only route and rejects selecting a text-only model while the session holds images. Users with a local OCR model wanted the harness to run OCR automatically and forward the recognized text to DeepSeek, keeping the image thumbnail visible in the conversation, without manually switching models.

## Decision

`@deepseek-ai/dsh-ocr-preprocess` is an opt-in service plugin in `packages/context/ocr-preprocess/`. Default compositions leave it disabled. A composition entry requires `provider` and `model` naming the OCR route; the `ocr-preprocess` settings namespace can override the route at runtime and adds optional `prompt`, `maxTokens`, and `timeoutMs`.

The plugin prepends an `agent/pre-step` listener and delegates first. When the downstream decision enters, each claimed user message with image content is checked: the serving model (latest `request/header` config, falling back to agent options) is resolved through `ctx.llm.resolveModelInfo`. A model declaring image input passes the message through untouched. Otherwise every image block is sent to the configured OCR model via `ctx.llm.stream`, and the recognized text replaces the image with the frame `[OCR of attached image]`. An empty OCR result becomes `[OCR of attached image: no text recognized]`. A failed, timed-out, or non-text OCR call surfaces a loud `LlmError` and aborts the turn.

Before the call, one `session/ocr-request` event is appended with the exact message id, image refs, prompt, route, token cap, and `rawOutput` (the complete OCR text blocks). The rewritten message is what the loop appends as `user/message` and derives into model history, so the OCR text is durable and reconstructable — model-visible content stays logged. The `./invariant` companion validates the record input side, `rawOutput`, and the relation that every OCR record is answered by its user message.

The `session/ocr-request` event is declared in the `SessionEventMap` and regenerated into `known-event-types` plus the persistence catalog, so persistence and replay treat it as a first-class log record. `llm-replay` derives a replay entry for the auxiliary OCR call from its `rawOutput`, so keyless snapshots replay the whole transformation.

While a route is configured, `ctx.ocrPreprocess.handlesImages()` returns true. The web host admission gates (`selectModel` and `prompt` in api-proxy) and the ACP inline-image gate consult it: with OCR preprocessing active, a text-only model may be selected and may accept images, because they are converted before the main model sees them. `supportsAcpImagePrompts` likewise advertises inline image prompts when OCR preprocessing handles them.

The client renders the original attachment from the `session/ocr-request` event next to the rewritten message, keeping the image thumbnail visible in the conversation (the user's explicit choice) while the model sees only the recognized text.

## Alternatives considered

- **Keep the image in the logged message and strip it at request time** — rejected because the agent-loop invariant requires request messages to equal the derived durable history; the image must leave the logged message.
- **Run OCR in the web host only** — rejected because the capability belongs on the transport-independent `agent/pre-step` seam so headless, ACP, and web deployments share it.
- **OCR every image regardless of the serving model** — rejected per the user's choice: an image-capable model receives the raw image untouched.
- **Drop the image silently** — rejected because the user chose to keep the thumbnail visible; the `session/ocr-request` event preserves the attachment for the UI.

## Verification

Package tests cover the pre-step rewrite for text-only routes, image-capable pass-through, unknown-route fallback, empty and non-text OCR output, max-token and upstream failures, settings overrides, and `handlesImages`. The invariant suite validates the record input side and the record-to-message relation. A real Loader composition boots `ocr-preprocess.cordis.yml` through a headless agent with a deterministic two-route adapter and asserts the durable log carries the OCR record, the rewritten message, and no raw image. The keyless ACP snapshot `ocr-preprocess` sends an inline image over a text-only route, replays both the OCR call and the main call, and pins the durable log and stdout transcript.

## Consequences

- Text-only models can accept images when OCR preprocessing is mounted, without switching models or touching the session header.
- The OCR text is model-visible and logged; the original image refs stay durable in the `session/ocr-request` event for UI rendering and replay.
- Auxiliary OCR calls are reconstructable from the log and replayable keylessly.
- The capability is opt-in; default bundles and compositions do not mount it.
