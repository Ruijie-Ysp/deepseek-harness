/**
 * Package-owned OCR preprocessing invariants.
 * @module @deepseek-ai/dsh-ocr-preprocess/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-ocr-preprocess'

/** Cordis companion plugin name. */
export const name = 'ocr-preprocess-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Model-facing frame the plugin prepends to recognized OCR text. */
const OCR_IMAGE_FRAME = '[OCR of attached image]'

/**
 * Narrow one event to the OCR preprocessing record shape when it is one.
 * @param event - a session event.
 * @returns the narrowed event, or undefined for any other type.
 */
function asOcrRequest(event: SessionEvent): Extract<SessionEvent, { type: 'session/ocr-request' }> | undefined {
  return event.type === 'session/ocr-request' ? event : undefined
}

/** Validate one OCR preprocessing record's input side. */
function validateRecord(event: Extract<SessionEvent, { type: 'session/ocr-request' }>, fail: InvariantFailure): void {
  const data = event.data
  if (data.messageId.length === 0) fail('session/ocr-request messageId must be non-empty')
  if (data.imageRefs.length === 0) fail('session/ocr-request must carry at least one image ref')
  if (data.prompt.length === 0) fail('session/ocr-request prompt must be non-empty')
  if (data.route.provider.length === 0 || data.route.model.length === 0) {
    fail('session/ocr-request route must carry provider and model')
  }
  if (!Number.isSafeInteger(data.maxTokens) || data.maxTokens <= 0) {
    fail('session/ocr-request maxTokens must be a positive safe integer')
  }
  if (!Array.isArray(data.rawOutput) || data.rawOutput.length === 0) {
    fail('session/ocr-request rawOutput must carry at least one content block')
  }
}

/**
 * Validate the model-visible relation of a complete session log: every OCR
 * record is answered by the user message it rewrote, and no OCR-framed user
 * message appears without its announcing record.
 * @param events - the session event log.
 * @param fail - invariant failure reporter.
 */
function validateRelations(events: readonly SessionEvent[], fail: InvariantFailure): void {
  const announced = new Map<string, boolean>()
  for (const event of events) {
    const ocr = asOcrRequest(event)
    if (ocr !== undefined) {
      announced.set(ocr.data.messageId, false)
      continue
    }
    if (event.type !== 'user/message') continue
    const id = String(event.data.id)
    const text = event.data.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
    if (announced.get(id) === false) {
      if (!text.includes(OCR_IMAGE_FRAME)) {
        fail('user/message announced by an OCR record must carry the OCR frame')
      }
      announced.set(id, true)
    } else if (text.includes(OCR_IMAGE_FRAME)) {
      fail('OCR-framed user/message must be announced by a session/ocr-request record')
    }
  }
  for (const [id, answered] of announced) {
    if (!answered) fail(`session/ocr-request for message ${id} must be answered by its user/message`)
  }
}

/** Validate all OCR records already present in one session. */
function validateSession(session: { events: readonly SessionEvent[] }, fail: InvariantFailure): void {
  for (const event of session.events) {
    const ocr = asOcrRequest(event)
    if (ocr !== undefined) validateRecord(ocr, fail)
  }
  validateRelations(session.events, fail)
}

/** Install validation for loaded and newly appended OCR records. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  for (const session of ctx.sessions.list()) validateSession(session, fail)
  ctx.on('session/created', (session) => { validateSession(session, fail) }, { global: true })
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [session: { events: readonly SessionEvent[] }, event: SessionEvent]
    const ocr = asOcrRequest(event)
    if (ocr !== undefined) validateRecord(ocr, fail)
    void session
  }, { global: true })
}, { inject: ['sessions'] })

/**
 * Register the OCR preprocessing invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
