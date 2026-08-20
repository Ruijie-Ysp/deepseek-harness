/**
 * Opt-in OCR preprocessing of image messages for text-only models. When a
 * claimed user message contains image content and the model that will serve
 * the request does not accept images, each image is sent to a configured OCR
 * model, and the recognized text replaces the image in the model-visible
 * message. The OCR call is logged as a durable session event carrying the
 * image refs, so the UI can still render the original attachment and the
 * whole transformation is reconstructable from the session log.
 *
 * @module @deepseek-ai/dsh-ocr-preprocess
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import {
  BlockAssembler,
  LlmError,
  createUserMessage,
  deepFreeze,
  freezeMessage,
} from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, Message, UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { deadline } from '@deepseek-ai/dsh-timeout'

/** Settings namespace carrying the OCR route and call policy. */
export const OCR_PREPROCESS_SETTINGS_NAMESPACE = settingsNamespace('ocr-preprocess')

/** Stored and composed OCR preprocessing policy. */
export interface OcrPreprocessSettings {
  /** Registered provider route of the OCR model. */
  provider: string
  /** Provider-owned OCR model id. */
  model: string
  /** Optional OCR instruction; defaults to the package instruction. */
  prompt?: string
  /** Optional output-token cap for the OCR call. */
  maxTokens?: number
  /** Optional end-to-end OCR call deadline in milliseconds. */
  timeoutMs?: number
}

/** Schema of the OCR preprocessing settings section. */
export const OCR_PREPROCESS_SETTINGS_SCHEMA: z<OcrPreprocessSettings> = z.object({
  provider: z.string().required(),
  model: z.string().required(),
  prompt: z.string(),
  maxTokens: z.number().step(1).min(1),
  timeoutMs: z.number().step(1).min(1),
})

/** Composition entry for the OCR route. */
export interface Config {
  /** Registered provider route of the OCR model. */
  provider: string
  /** Provider-owned OCR model id. */
  model: string
}

/** Default OCR instruction sent to the OCR model. */
export const DEFAULT_OCR_PROMPT =
  'Extract all text from this image. Return only the extracted text, preserving line breaks where they matter. If the image contains no text, return exactly the word NONE.'

/** Timeout code for an OCR call that outlived its deadline. */
export const OCR_PREPROCESS_TIMEOUT_CODE = 'OCR_PREPROCESS_TIMEOUT'

/** Failure code for an OCR call that errored or produced unusable output. */
export const OCR_PREPROCESS_FAILED_CODE = 'OCR_PREPROCESS_FAILED'

/** Model-facing frame replacing one image with its recognized text. */
const OCR_IMAGE_FRAME = '[OCR of attached image]'
/** Model-facing placeholder when the OCR model recognized no text. */
const OCR_EMPTY_RESULT = '[OCR of attached image: no text recognized]'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Whether OCR preprocessing is configured and will convert images before the model sees them. */
    ocrPreprocess: OcrPreprocess
  }
}

export type { SessionOcrRequestEventData } from './types.ts'

/**
 * Runs the OCR preprocessing pipeline. Mounting the plugin registers a
 * pre-step listener that rewrites image-bearing user messages when the model
 * that will serve the request does not accept images, and exposes
 * {@link handlesImages} so host admission gates can admit images for
 * text-only models.
 */
export class OcrPreprocess extends Service {
  static inject = ['llm']
  static Config: z<Config> = z.object({
    provider: z.string().required(),
    model: z.string().required(),
  })

  private source: () => OcrPreprocessSettings

  constructor(ctx: Context, config: Config) {
    super(ctx, 'ocrPreprocess')
    const entry: OcrPreprocessSettings = { provider: config.provider, model: config.model }
    this.source = () => entry
    installSettingsSection(ctx, OCR_PREPROCESS_SETTINGS_NAMESPACE, OCR_PREPROCESS_SETTINGS_SCHEMA, entry, {
      setSource: (current) => { this.source = current },
      onChange: () => {},
    })
    ctx.on('agent/pre-step', async ({ agent, signal }, next): Promise<PreStepDecision> => {
      const decision = await next()
      if (decision.kind === 'reject') return decision
      const settings = this.source()
      if (settings.provider.length === 0 || settings.model.length === 0) return decision
      const rewritten = await Promise.all(decision.messages.map(async (message) => {
        if (message.source.kind !== 'user') return message
        const images = message.content.filter(
          (block): block is Extract<ContentBlock, { type: 'image' }> => block.type === 'image',
        )
        if (images.length === 0) return message
        if (await modelAcceptsImages(agent, ctx)) return message
        const content = await ocrContent(ctx, agent.session, message, images, settings, signal)
        return freezeMessage({ ...message, content })
      }))
      return { kind: 'enter', messages: rewritten }
    }, { prepend: true })
  }

  /**
   * Whether a usable OCR route is configured, so image admission gates can
   * accept images for text-only models.
   * @returns true when both provider and model are non-empty.
   */
  handlesImages(): boolean {
    const settings = this.source()
    return settings.provider.length > 0 && settings.model.length > 0
  }
}

/** Whether the model that will serve the next request accepts image input. */
async function modelAcceptsImages(agent: Agent, ctx: Context): Promise<boolean> {
  const header = agent.session.requestHeader()?.config
  const provider = header?.provider ?? agent.options.provider
  const model = header?.model ?? agent.options.model
  if (provider === undefined || model === undefined) return false
  const info = await ctx.llm.resolveModelInfo(provider, model)
  return info.inputModalities?.includes('image') === true
}

/**
 * Run the OCR model over each image block and rewrite the message content.
 * @param ctx - harness context with the LLM service.
 * @param session - the session owning the claimed message.
 * @param message - the claimed user message carrying the images.
 * @param images - every image block in message content, in order.
 * @param settings - resolved OCR route and call policy.
 * @param signal - the turn's cancellation signal, forwarded to the OCR call.
 * @returns the rewritten content, or the original when nothing changed.
 */
async function ocrContent(
  ctx: Context,
  session: Session,
  message: UserMessage,
  images: Array<Extract<ContentBlock, { type: 'image' }>>,
  settings: OcrPreprocessSettings,
  signal: AbortSignal,
): Promise<ContentBlock[]> {
  const prompt = settings.prompt ?? DEFAULT_OCR_PROMPT
  const maxTokens = settings.maxTokens ?? 2048
  const timeoutMs = settings.timeoutMs ?? 60000
  const route = { provider: settings.provider, model: settings.model }
  const recognized: Array<{ image: Extract<ContentBlock, { type: 'image' }>; output: string; blocks: ContentBlock[] }> = []
  for (const image of images) {
    const result = await runOcr(ctx, session, image, prompt, route, maxTokens, timeoutMs, signal)
    recognized.push({
      image,
      output: result.output.length > 0 ? result.output : OCR_EMPTY_RESULT,
      blocks: result.output.length > 0 ? result.blocks : [{ type: 'text', text: OCR_EMPTY_RESULT }],
    })
  }
  session.append('session/ocr-request', {
    messageId: message.id,
    imageRefs: recognized.map(entry => entry.image.attachment),
    prompt,
    route,
    maxTokens,
    rawOutput: recognized.flatMap(entry => entry.blocks),
  })
  const framed = recognized.map(entry => [OCR_IMAGE_FRAME, entry.output].join('\n'))
  let next = 0
  return message.content.map((block) => {
    if (block.type !== 'image') return block
    const frame = framed[next]
    next += 1
    // framed holds one entry per image block (built from the same image filter
    // this map rewrites), so the index always lands in range.
    /* v8 ignore next -- framed.length equals the image-block count by construction */
    if (frame === undefined) throw new Error('ocr-preprocess: OCR frames diverged from image blocks')
    return { type: 'text', text: frame }
  })
}

/**
 * Run one OCR model call and assemble its text output.
 * @param ctx - harness context with the LLM service.
 * @param session - the session owning the claimed message.
 * @param image - the image block to recognize.
 * @param prompt - the OCR instruction.
 * @param route - the OCR provider/model pair from settings.
 * @param maxTokens - the output-token cap.
 * @param timeoutMs - the end-to-end deadline.
 * @param signal - caller cancellation.
 * @returns the assembled OCR text and its source blocks (possibly empty).
 * @throws {LlmError} when the OCR call fails or times out.
 */
async function runOcr(
  ctx: Context,
  session: Session,
  image: Extract<ContentBlock, { type: 'image' }>,
  prompt: string,
  route: { readonly provider: string; readonly model: string },
  maxTokens: number,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<{ output: string; blocks: ContentBlock[] }> {
  const messages: Message[] = [createUserMessage({
    content: [image, { type: 'text', text: prompt }],
    source: { kind: 'plugin', plugin: 'dsh-ocr-preprocess' },
  })]
  using callDeadline = deadline(signal, timeoutMs, OCR_PREPROCESS_TIMEOUT_CODE)
  const options: GenerateOptions = deepFreeze({
    provider: route.provider,
    model: route.model,
    messages,
    maxTokens,
    sessionId: session.id,
    signal: callDeadline.signal,
  })
  const assembler = new BlockAssembler()
  for await (const chunk of ctx.llm.stream(options)) {
    callDeadline.signal.throwIfAborted()
    assembler.push(chunk)
  }
  callDeadline.signal.throwIfAborted()
  const finish = assembler.finish
  if (finish.kind === 'error' || finish.kind === 'aborted') {
    throw new LlmError(
      `OCR preprocessing failed: ${finish.failure.message}`,
      finish.failure.code,
      { cause: finish.failure },
    )
  }
  if (finish.kind === 'max-tokens') {
    throw new LlmError('OCR preprocessing output reached maxTokens', OCR_PREPROCESS_FAILED_CODE)
  }
  const blocks = assembler.blocks()
  if (blocks.some(block => block.type !== 'text')) {
    throw new LlmError('OCR preprocessing output must contain text only', OCR_PREPROCESS_FAILED_CODE)
  }
  return {
    output: blocks
      .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
      .map(block => block.text)
      .join(''),
    blocks,
  }
}

export default OcrPreprocess
