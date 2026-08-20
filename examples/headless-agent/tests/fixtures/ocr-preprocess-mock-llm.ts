import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, ModelModality, StreamChunk } from '@deepseek-ai/dsh-llm'

/**
 * Deterministic two-route adapter for the ocr-preprocess Loader fixture: the
 * main route is text-only and answers with a fixed acknowledgment, while the
 * OCR route recognizes the image and emits its recognized text.
 */
class OcrPreprocessMockAdapter extends LlmAdapter {
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const text = options.provider === 'ocr-mock' ? 'RECOGNIZED-TEXT' : 'understood the message'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  override async resolveModel(
    provider: string,
    model: string,
  ): Promise<{ provider: string; id: string; name: string; inputModalities?: readonly ModelModality[] }> {
    return {
      provider,
      id: model,
      name: model,
      inputModalities: provider === 'ocr-mock' ? ['text', 'image'] : ['text'],
    }
  }
}

export const name = 'ocr-preprocess-mock-llm'
export const inject = ['llm']

/** Register the test-only `ocr-mock` and `main-mock` adapters. */
export function apply(ctx: Context): void {
  ctx.llm.registerAdapter(['ocr-mock', 'main-mock'], new OcrPreprocessMockAdapter())
}
