/** OCR preprocessing: pre-step image-to-text rewrite driven through a real loop. */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import { CallId } from '@deepseek-ai/dsh-llm/brand'
import type { GenerateOptions, ModelModality, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { agentEvents, Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import OcrPreprocess, {
  OCR_PREPROCESS_FAILED_CODE,
  OCR_PREPROCESS_SETTINGS_NAMESPACE,
} from '@deepseek-ai/dsh-ocr-preprocess'
import type { Config } from '@deepseek-ai/dsh-ocr-preprocess'

const SIGNAL = new AbortController().signal

function sessionAgent(session: Session, options: { provider?: string; model?: string } = {}): Agent {
  return {
    id: SessionId('agent'),
    options,
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'running',
    ctx: new Context(),
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => { throw new Error('ocr-preprocess must append directly') },
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

const IMAGE_REF: ImageAttachmentRef = {
  attachmentId: 'img-1' as never,
  mediaType: 'image/png',
  bytes: 69,
  width: 1,
  height: 1,
}

function imageMessage(text = 'hello user'): ReturnType<typeof createUserMessage> {
  return createUserMessage({
    content: [
      { type: 'text', text },
      { type: 'image', attachment: IMAGE_REF },
    ],
    source: { kind: 'user' },
  })
}

function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function toolCallResponse(): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    {
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: 'tick-1' as never, name: 'tick', arguments: '{}' },
    },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(
    private readonly script: StreamChunk[][],
    private readonly modalitiesByModel: Record<string, readonly ModelModality[] | undefined> = {},
    private readonly defaultModalities: readonly ModelModality[] = ['text', 'image'],
  ) {
    super()
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const chunks = this.script.shift()
    if (chunks === undefined) throw new Error('ScriptedAdapter: script exhausted')
    for (const chunk of chunks) yield chunk
  }

  override async resolveModel(
    provider: string,
    model: string,
  ): Promise<{ provider: string; id: string; name: string; inputModalities?: readonly ModelModality[] }> {
    const inputModalities = this.modalitiesByModel[model] ?? this.defaultModalities
    return { provider, id: model, name: model, inputModalities }
  }
}

/** The smallest real settings provider: one in-memory document, always writable. */
class MemorySettings extends SettingsProvider {
  doc: Record<string, unknown> = {}

  get writable(): boolean {
    return true
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc = { ...this.doc, [ns]: structuredClone(section) }
    return Promise.resolve()
  }
}

async function loopHarness(adapter: ScriptedAdapter, config: Config): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(MemorySettings)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(OcrPreprocess, config)
  ctx.llm.registerAdapter(['main', 'ocr'], adapter)
  return ctx
}

async function fire(ctx: Context, agent: Agent, turn: number, step: number): Promise<void> {
  const message = imageMessage()
  const decision = await agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    { messages: [message], turn, step, signal: SIGNAL },
    () => Promise.resolve({ kind: 'enter' as const, messages: [message] }),
  )
  if (decision.kind === 'enter') {
    for (const claimed of decision.messages) {
      if (claimed === message) continue
      agent.session.append('user/message', claimed, { surfaceOp: 'append' })
    }
  }
}

describe('ocr-preprocess', () => {
  it('rewrites an image message with OCR text for a text-only model and logs the OCR call', async () => {
    const adapter = new ScriptedAdapter(
      [textResponse('recognized text')],
      { deepseek: ['text'], ovisocr2: ['text', 'image'] },
    )
    const ctx = await loopHarness(adapter, { provider: 'ocr', model: 'ovisocr2' })
    const session = ctx.sessions.create(SessionId('session'))
    const agent = sessionAgent(session, { provider: 'main', model: 'deepseek' })
    await fire(ctx, agent, 1, 1)
    const userEvents = session.events.filter(event => event.type === 'user/message')
    expect(userEvents).toHaveLength(1)
    const content = (userEvents[0] as SessionEvent<'user/message'>).data.content
    const text = content
      .filter(block => block.type === 'text')
      .map(block => (block as { text: string }).text)
      .join('')
    expect(text).toContain('[OCR of attached image]')
    expect(text).toContain('recognized text')
    expect(content.some(block => block.type === 'image')).toBe(false)

    const ocrEvents = session.events.filter(
      (event): event is SessionEvent<'session/ocr-request'> => event.type === 'session/ocr-request')
    expect(ocrEvents).toHaveLength(1)
    expect(ocrEvents[0]!.data.messageId).toBe(String((userEvents[0] as SessionEvent<'user/message'>).data.id))
    expect(ocrEvents[0]!.data.imageRefs).toEqual([IMAGE_REF])
    expect(ocrEvents[0]!.data.route).toEqual({ provider: 'ocr', model: 'ovisocr2' })
    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]!.provider).toBe('ocr')
    expect(adapter.requests[0]!.model).toBe('ovisocr2')
    expect(adapter.requests[0]!.maxTokens).toBe(2048)
    expect(adapter.requests[0]!.messages[0]!.content.some(block => block.type === 'image')).toBe(true)
    await ctx.fiber.dispose()
  })

  it('passes the image through when the serving model accepts images', async () => {
    const adapter = new ScriptedAdapter([], { vision: ['text', 'image'], ovisocr2: ['text', 'image'] })
    const ctx = await loopHarness(adapter, { provider: 'ocr', model: 'ovisocr2' })
    const session = ctx.sessions.create(SessionId('session'))
    const agent = sessionAgent(session, { provider: 'main', model: 'vision' })
    const message = imageMessage()
    const decision = await agentEvents(ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [message], turn: 1, step: 1, signal: SIGNAL },
      () => Promise.resolve({ kind: 'enter' as const, messages: [message] }),
    )
    expect(decision.kind).toBe('enter')
    if (decision.kind === 'enter') {
      expect(decision.messages).toHaveLength(1)
      expect(decision.messages[0]).toBe(message)
    }
    expect(session.events.some(event => event.type === 'session/ocr-request')).toBe(false)
    expect(adapter.requests).toHaveLength(0)
    await ctx.fiber.dispose()
  })

  it('fails loudly when the OCR model errors', async () => {
    const adapter = new ScriptedAdapter(
      [
        [
          { type: 'block-start', index: 0, blockType: 'text' },
          {
            type: 'block-end',
            index: 0,
            block: { type: 'text', text: 'partial' },
          },
          { type: 'finish', reason: { kind: 'error', failure: { code: 'UPSTREAM', message: 'boom' } } },
        ],
      ],
      { deepseek: ['text'], ovisocr2: ['text', 'image'] },
    )
    const ctx = await loopHarness(adapter, { provider: 'ocr', model: 'ovisocr2' })
    const session = ctx.sessions.create(SessionId('session'))
    const agent = sessionAgent(session, { provider: 'main', model: 'deepseek' })
    await expect(fire(ctx, agent, 1, 1)).rejects.toMatchObject({ code: 'UPSTREAM' })
    expect(session.events.some(event => event.type === 'user/message')).toBe(false)
    await ctx.fiber.dispose()
  })

  it('fails loudly when the OCR model produces non-text output', async () => {
    const adapter = new ScriptedAdapter([toolCallResponse()], { deepseek: ['text'], ovisocr2: ['text', 'image'] })
    const ctx = await loopHarness(adapter, { provider: 'ocr', model: 'ovisocr2' })
    const session = ctx.sessions.create(SessionId('session'))
    const agent = sessionAgent(session, { provider: 'main', model: 'deepseek' })
    await expect(fire(ctx, agent, 1, 1)).rejects.toMatchObject({ code: OCR_PREPROCESS_FAILED_CODE })
    await ctx.fiber.dispose()
  })

  it('uses a custom prompt and maxTokens from settings', async () => {
    const adapter = new ScriptedAdapter(
      [textResponse('recognized')],
      { deepseek: ['text'], ovisocr2: ['text', 'image'] },
    )
    const ctx = await loopHarness(adapter, { provider: 'ocr', model: 'ovisocr2' })
    await ctx.settings.replace(OCR_PREPROCESS_SETTINGS_NAMESPACE, { provider: 'ocr', model: 'ovisocr2', prompt: 'custom prompt', maxTokens: 512 })
    const session = ctx.sessions.create(SessionId('session'))
    const agent = sessionAgent(session, { provider: 'main', model: 'deepseek' })
    await fire(ctx, agent, 1, 1)
    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]!.maxTokens).toBe(512)
    await ctx.fiber.dispose()
  })

  it('handlesImages reflects a configured route', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(OcrPreprocess, { provider: 'ocr', model: 'ovisocr2' })
    expect(ctx.ocrPreprocess.handlesImages()).toBe(true)
    await ctx.plugin(MemorySettings)
    await ctx.settings.replace(OCR_PREPROCESS_SETTINGS_NAMESPACE, { provider: '', model: '' })
    expect(ctx.ocrPreprocess.handlesImages()).toBe(false)
    await ctx.fiber.dispose()
  })

  it('leaves messages unchanged when the OCR route is unset or the step is rejected', async () => {
    const adapter = new ScriptedAdapter([textResponse('x')], { deepseek: ['text'], ovisocr2: ['text', 'image'] })
    const ctx = await loopHarness(adapter, { provider: 'ocr', model: 'ovisocr2' })
    const session = ctx.sessions.create(SessionId('session'))
    const agent = sessionAgent(session, { provider: 'main', model: 'deepseek' })
    const rejected = await agentEvents(ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [imageMessage()], turn: 1, step: 1, signal: SIGNAL },
      () => Promise.resolve({ kind: 'reject' as const }),
    )
    expect(rejected.kind).toBe('reject')
    await ctx.settings.replace(OCR_PREPROCESS_SETTINGS_NAMESPACE, { provider: '', model: '' })
    const message = imageMessage()
    const decision = await agentEvents(ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [message], turn: 1, step: 1, signal: SIGNAL },
      () => Promise.resolve({ kind: 'enter' as const, messages: [message] }),
    )
    expect(decision.kind).toBe('enter')
    if (decision.kind === 'enter') {
      expect(decision.messages[0]).toBe(message)
    }
    expect(adapter.requests).toHaveLength(0)
    await ctx.fiber.dispose()
  })

  it('leaves non-user and image-free messages untouched', async () => {
    const adapter = new ScriptedAdapter([textResponse('x')], { deepseek: ['text'], ovisocr2: ['text', 'image'] })
    const ctx = await loopHarness(adapter, { provider: 'ocr', model: 'ovisocr2' })
    const session = ctx.sessions.create(SessionId('session'))
    const agent = sessionAgent(session, { provider: 'main', model: 'deepseek' })
    const tool = createUserMessage({
      content: [{ type: 'text', text: 'tool echo' }],
      source: { kind: 'tool', callId: CallId('c1') },
    })
    const plain = createUserMessage({
      content: [{ type: 'text', text: 'plain' }],
      source: { kind: 'user' },
    })
    const decision = await agentEvents(ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [tool, plain], turn: 1, step: 1, signal: SIGNAL },
      () => Promise.resolve({ kind: 'enter' as const, messages: [tool, plain] }),
    )
    expect(decision.kind).toBe('enter')
    if (decision.kind === 'enter') {
      expect(decision.messages).toEqual([tool, plain])
    }
    expect(adapter.requests).toHaveLength(0)
    await ctx.fiber.dispose()
  })

  it('falls back to OCR when the serving route is unknown (no header and no agent options)', async () => {
    const adapter = new ScriptedAdapter([textResponse('recognized')], { deepseek: ['text'], ovisocr2: ['text', 'image'] })
    const ctx = await loopHarness(adapter, { provider: 'ocr', model: 'ovisocr2' })
    const session = ctx.sessions.create(SessionId('session'))
    const agent = sessionAgent(session)
    await fire(ctx, agent, 1, 1)
    expect(session.events.some(event => event.type === 'session/ocr-request')).toBe(true)
    expect(adapter.requests).toHaveLength(1)
    await ctx.fiber.dispose()
  })

  it('frames an empty OCR result as no-text-recognized', async () => {
    const adapter = new ScriptedAdapter([textResponse('')], { deepseek: ['text'], ovisocr2: ['text', 'image'] })
    const ctx = await loopHarness(adapter, { provider: 'ocr', model: 'ovisocr2' })
    const session = ctx.sessions.create(SessionId('session'))
    const agent = sessionAgent(session, { provider: 'main', model: 'deepseek' })
    await fire(ctx, agent, 1, 1)
    const userEvents = session.events.filter(event => event.type === 'user/message')
    const text = (userEvents[0] as SessionEvent<'user/message'>).data.content
      .filter(block => block.type === 'text')
      .map(block => (block as { text: string }).text)
      .join('')
    expect(text).toContain('no text recognized')
    await ctx.fiber.dispose()
  })

  it('fails loudly when the OCR call reaches maxTokens', async () => {
    const adapter = new ScriptedAdapter([
      [
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'block-end', index: 0, block: { type: 'text', text: 'a'.repeat(10) } },
        { type: 'finish', reason: { kind: 'max-tokens' } },
      ],
    ], { deepseek: ['text'], ovisocr2: ['text', 'image'] })
    const ctx = await loopHarness(adapter, { provider: 'ocr', model: 'ovisocr2' })
    const session = ctx.sessions.create(SessionId('session'))
    const agent = sessionAgent(session, { provider: 'main', model: 'deepseek' })
    await expect(fire(ctx, agent, 1, 1)).rejects.toMatchObject({ code: OCR_PREPROCESS_FAILED_CODE })
    await ctx.fiber.dispose()
  })
})
