/** OCR preprocessing invariant companion coverage. */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { freezeMessage } from '@deepseek-ai/dsh-llm'
import { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import * as OcrInvariant from '@deepseek-ai/dsh-ocr-preprocess/invariant'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'

const IMAGE_REF: ImageAttachmentRef = {
  attachmentId: 'img-1' as never,
  mediaType: 'image/png',
  bytes: 69,
  width: 1,
  height: 1,
}

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry, { enabled: true })
  await ctx.plugin(OcrInvariant)
  return ctx
}

function ocrEvent(seq: number, overrides: Partial<Record<'messageId' | 'imageRefs' | 'prompt' | 'maxTokens' | 'route' | 'rawOutput', unknown>> = {}): SessionEvent<'session/ocr-request'> {
  return {
    type: 'session/ocr-request',
    seq,
    time: Date.now(),
    data: {
      messageId: 'msg-1',
      imageRefs: [IMAGE_REF],
      prompt: 'Extract all text',
      route: { provider: 'ocr', model: 'ovisocr2' },
      maxTokens: 2048,
      rawOutput: [{ type: 'text', text: 'HELLO' }],
      ...overrides,
    } as never,
  }
}

function userMessageEvent(seq: number, id: string, text: string): SessionEvent<'user/message'> {
  return {
    type: 'user/message',
    seq,
    time: Date.now(),
    data: freezeMessage({
      id: MessageId(id),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }),
    surfaceOp: 'append',
  } as unknown as SessionEvent<'user/message'>
}

describe('ocr-preprocess invariants', () => {
  it('validates sessions already present when the companion installs', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    ctx.sessions.create(SessionId('s0'), {
      seed: [
        ocrEvent(0),
        userMessageEvent(1, 'msg-1', '[OCR of attached image]\nrecognized'),
      ],
    })
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await ctx.plugin(OcrInvariant)
    await ctx.fiber.dispose()
  })

  it('accepts a record followed by its OCR-framed user message', async () => {
    const ctx = await setup()
    expect(() => {
      ctx.sessions.create(SessionId('s1'), {
        seed: [
          ocrEvent(0),
          userMessageEvent(1, 'msg-1', '[OCR of attached image]\nrecognized'),
        ],
      })
    }).not.toThrow()
  })

  it('rejects a record with an empty messageId', async () => {
    const ctx = await setup()
    expect(() => {
      ctx.sessions.create(SessionId('s2'), { seed: [ocrEvent(0, { messageId: '' })] })
    }).toThrow(/messageId/)
  })

  it('rejects a record without image refs', async () => {
    const ctx = await setup()
    expect(() => {
      ctx.sessions.create(SessionId('s3'), { seed: [ocrEvent(0, { imageRefs: [] })] })
    }).toThrow(/image ref/)
  })

  it('rejects a record with an empty prompt', async () => {
    const ctx = await setup()
    expect(() => {
      ctx.sessions.create(SessionId('s4'), { seed: [ocrEvent(0, { prompt: '' })] })
    }).toThrow(/prompt/)
  })

  it('rejects a record with an empty route or invalid maxTokens', async () => {
    const ctx = await setup()
    expect(() => {
      ctx.sessions.create(SessionId('s5'), { seed: [ocrEvent(0, { route: { provider: '', model: '' } })] })
    }).toThrow(/route/)
    expect(() => {
      ctx.sessions.create(SessionId('s6'), { seed: [ocrEvent(0, { maxTokens: 0 })] })
    }).toThrow(/maxTokens/)
  })

  it('rejects a record without rawOutput', async () => {
    const ctx = await setup()
    expect(() => {
      ctx.sessions.create(SessionId('s6b'), { seed: [ocrEvent(0, { rawOutput: [] })] })
    }).toThrow(/rawOutput/)
  })

  it('rejects an OCR-framed user message without its announcing record', async () => {
    const ctx = await setup()
    expect(() => {
      ctx.sessions.create(SessionId('s7'), {
        seed: [userMessageEvent(0, 'orphan', '[OCR of attached image]\nrecognized')],
      })
    }).toThrow(/announced/)
  })

  it('rejects a record never answered by its user message', async () => {
    const ctx = await setup()
    expect(() => {
      ctx.sessions.create(SessionId('s8'), { seed: [ocrEvent(0)] })
    }).toThrow(/answered/)
  })

  it('rejects a user message announced by a record but missing the OCR frame', async () => {
    const ctx = await setup()
    expect(() => {
      ctx.sessions.create(SessionId('s9'), {
        seed: [
          ocrEvent(0, { messageId: 'noframe' }),
          userMessageEvent(1, 'noframe', 'plain text'),
        ],
      })
    }).toThrow(/frame/)
  })

  it('rejects a second framed message reusing an answered message id', async () => {
    const ctx = await setup()
    expect(() => {
      ctx.sessions.create(SessionId('s9b'), {
        seed: [
          ocrEvent(0, { messageId: 'twice' }),
          userMessageEvent(1, 'twice', '[OCR of attached image]\nfirst'),
          userMessageEvent(2, 'twice', '[OCR of attached image]\nsecond'),
        ],
      })
    }).toThrow(/announced/)
  })

  it('accepts a later plain message reusing an answered message id', async () => {
    const ctx = await setup()
    expect(() => {
      ctx.sessions.create(SessionId('s9c'), {
        seed: [
          ocrEvent(0, { messageId: 'plain-later' }),
          userMessageEvent(1, 'plain-later', '[OCR of attached image]\nfirst'),
          userMessageEvent(2, 'plain-later', 'plain follow-up'),
        ],
      })
    }).not.toThrow()
  })

  it('validates a record input on dispatch', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('s10'))
    expect(() => {
      ctx.emit('session/event', session, ocrEvent(0, { prompt: '' }))
    }).toThrow(/prompt/)
  })
})
