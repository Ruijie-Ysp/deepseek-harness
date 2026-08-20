import type { Context } from '@deepseek-ai/cordis'
import type {
  ContextMessageNode, ConversationNodeDefinition, SteeringMessageNode, UserEditMessageNode,
  UserMessageNode,
} from '@deepseek-ai/dsh-client-runtime/client'
import {
  contextForm, contextProvenance, isAppendSurfaceEvent, isReplacementSurfaceEvent,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { InboxState } from './inbox.ts'
import { chatNode } from './common.ts'
import type { OcrRequestState } from './ocr-request.ts'

interface ReferencedUserMessageNode extends UserMessageNode {
  /** Labels cited by the immediately following session-reference context. */
  readonly referenceLabels?: readonly string[]
  /** Image attachments OCR-preprocessed out of this message's content. */
  readonly ocrImages?: readonly { readonly attachment: ImageAttachmentRef }[]
}

interface ReferencedSteeringMessageNode extends SteeringMessageNode {
  /** Labels cited by the immediately following session-reference context. */
  readonly referenceLabels?: readonly string[]
  /** Image attachments OCR-preprocessed out of this message's content. */
  readonly ocrImages?: readonly { readonly attachment: ImageAttachmentRef }[]
}

type MessageNode = ReferencedUserMessageNode | ReferencedSteeringMessageNode | ContextMessageNode

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ChatNodeDataMap {
    /** Ordinary turn-opening user message. */
    user: ReferencedUserMessageNode
    /** User message admitted into an active turn. */
    steering: ReferencedSteeringMessageNode
    /** Non-user context injected into model history. */
    context: ContextMessageNode
    /** Human rewrite of an earlier user message; its turn regenerated the conversation. */
    'user-edit': UserEditMessageNode
  }
}

function isCompactionCheckpoint(event: Parameters<ConversationNodeDefinition['match']>[0]): boolean {
  if (event.type !== 'user/message' || !isReplacementSurfaceEvent(event)) return false
  const source = event.data.source
  return source.kind === 'plugin' && source.plugin === 'compact'
}

/** User, steering, and injected-context message classification Definition. */
export const messageDefinition: ConversationNodeDefinition<MessageNode> = {
  kind: 'input-message',
  target: 'chat',
  match: event => event.type === 'user/message'
    && isAppendSurfaceEvent(event)
    && !isCompactionCheckpoint(event)
    ? { id: String(event.data.id), role: 'start' }
    : null,
  start: (_context, match, reader) => {
    if (match.event.type !== 'user/message') throw new Error('input-message start requires user/message')
    const event = match.event
    if (event.data.source.kind !== 'user') {
      return {
        kind: 'context',
        seq: event.seq,
        time: event.time,
        content: event.data.content,
        source: event.data.source,
        provenance: contextProvenance(event.data.source),
        form: contextForm(event.data.source),
      }
    }
    const claimed = reader.previous<InboxState>('inbox-next-step')?.state.claimed.has(String(event.data.id)) === true
    const ocr = reader.previous<OcrRequestState>('ocr-request')
    const ocrImages = ocr !== undefined && ocr.state.messageId === String(event.data.id)
      ? ocr.state.imageRefs.map(attachment => ({ attachment }))
      : undefined
    return claimed
      ? {
        kind: 'steering',
        messageId: event.data.id,
        seq: event.seq,
        time: event.time,
        content: event.data.content,
        source: event.data.source,
        ...ocrImages === undefined ? {} : { ocrImages },
      }
      : {
        kind: 'user',
        seq: event.seq,
        time: event.time,
        content: event.data.content,
        source: event.data.source,
        ...ocrImages === undefined ? {} : { ocrImages },
      }
  },
  update: context => context.state,
  buildViewNode: (context) => {
    if (context.state === undefined) return null
    return chatNode(context, context.state.kind, context.state.seq, context.state)
  },
}

/**
 * Register the user, steering, and injected-context message contribution.
 * @param ctx - owning UI Conversation context.
 */
export function registerMessageConversationNode(ctx: Context): void {
  ctx.conversationEvents.register(messageDefinition)
  ctx.conversationEvents.register(userEditDefinition)
}

/** Human rewrite of an earlier user message (the loop's durable `user/edit` append). */
export const userEditDefinition: ConversationNodeDefinition<UserEditMessageNode> = {
  kind: 'user-edit',
  target: 'chat',
  match: event => event.type === 'user/edit'
    ? { id: String(event.data.message.id), role: 'start' }
    : null,
  start: (_context, match) => {
    if (match.event.type !== 'user/edit') throw new Error('user-edit start requires user/edit')
    return {
      kind: 'user-edit',
      seq: match.event.seq,
      time: match.event.time,
      content: match.event.data.message.content,
      replacesSeq: match.event.data.replacesSeq,
    }
  },
  update: context => context.state,
  buildViewNode: (context) => {
    if (context.state === undefined) return null
    return chatNode(context, context.state.kind, context.state.seq, context.state)
  },
}
