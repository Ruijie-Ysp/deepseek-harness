import type { Context } from '@deepseek-ai/cordis'
import type {
  ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
// Type-only side effect: widens the client SessionEvent union with
// `session/ocr-request` so this Definition can match the OCR record.
import type {} from '@deepseek-ai/dsh-ocr-preprocess/types'

/** Image refs recorded by one OCR preprocessing call, in message order. */
export interface OcrRequestState {
  /** Durable id of the claimed user message this call rewrote. */
  readonly messageId: string
  /** Image refs the following user message's content replaced with text. */
  readonly imageRefs: readonly ImageAttachmentRef[]
}

/** State-only OCR preprocessing record: image refs for the message that follows it. */
export const ocrRequestDefinition: ConversationNodeDefinition<OcrRequestState> = {
  kind: 'ocr-request',
  match: event => event.type === 'session/ocr-request'
    ? { id: String(event.seq), role: 'start' }
    : null,
  start: (_context, match) => {
    if (match.event.type !== 'session/ocr-request') {
      throw new Error('ocr-request start requires session/ocr-request')
    }
    return {
      messageId: match.event.data.messageId,
      imageRefs: match.event.data.imageRefs,
    }
  },
  update: context => context.state,
  publication: () => 'none',
}

/**
 * Register the OCR preprocessing state contribution.
 * @param ctx - owning UI Conversation context.
 */
export function registerOcrRequestConversationNode(ctx: Context): void {
  ctx.conversationEvents.register(ocrRequestDefinition)
}
