/** OCR preprocessing public types. @module @deepseek-ai/dsh-ocr-preprocess/types */

import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

/** Exact auxiliary call recorded before one OCR dispatch. */
export interface SessionOcrRequestEventData {
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

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Log-only pre-dispatch record of one OCR preprocessing call. */
    'session/ocr-request': SessionOcrRequestEventData
  }
}
