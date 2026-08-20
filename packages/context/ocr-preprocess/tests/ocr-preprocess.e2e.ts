import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { type SessionEvent } from '@deepseek-ai/dsh-session'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

// Keep the Loader config under examples so both modes exercise the same deployable
// topology: local fixture source plus bare plugins owned by the examples workspace.
const driver = fileURLToPath(new URL(
  '../../../../examples/headless-agent/tests/fixtures/ocr-preprocess-driver.ts',
  import.meta.url,
))
const configPath = fileURLToPath(new URL(
  '../../../../examples/headless-agent/tests/fixtures/ocr-preprocess.cordis.yml',
  import.meta.url,
))
const repoTsconfig = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))

async function jsonlFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const paths = await Promise.all(entries.map(async (entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return jsonlFiles(path)
    return entry.isFile() && entry.name.endsWith('.jsonl') ? [path] : []
  }))
  return paths.flat()
}

describe('ocr-preprocess through a real headless cordis.yml', () => {
  it('replaces the image with recognized text before the text-only model sees it', async () => {
    let events: SessionEvent[] = []
    const { stderr } = await runLoaderSmoke({
      label: 'ocr-preprocess headless smoke',
      tempDirPrefix: 'ocr-preprocess-e2e-',
      binScript: driver,
      libBinScript: driver,
      configPath,
      tsconfigPath: repoTsconfig,
      inspect: async (cwd) => {
        const logs = await jsonlFiles(join(cwd, '.sessions'))
        expect(logs).toHaveLength(1)
        const lines = (await readFile(logs[0] as string, 'utf8')).trimEnd().split('\n')
        events = lines.slice(1).map(line => JSON.parse(line) as SessionEvent)
      },
    })
    expect(stderr).not.toContain('UNHANDLED')
    expect(events.filter(event => event.type === 'turn/end')).toHaveLength(1)

    const ocrEvents = events.filter(
      (event): event is SessionEvent<'session/ocr-request'> => event.type === 'session/ocr-request')
    expect(ocrEvents).toHaveLength(1)
    const userEvents = events.filter(event => event.type === 'user/message')
    const rewritten = userEvents.find(
      (event): event is SessionEvent<'user/message'> =>
        event.type === 'user/message'
        && String(event.data.id) === ocrEvents[0]!.data.messageId)
    expect(rewritten).toBeDefined()
    const text = (rewritten as SessionEvent<'user/message'>).data.content
      .filter(block => block.type === 'text')
      .map(block => (block as { text: string }).text)
      .join('')
    expect(text).toContain('RECOGNIZED-TEXT')
    // The model-visible message never carries the raw image.
    expect((rewritten as SessionEvent<'user/message'>).data.content.some(block => block.type === 'image'))
      .toBe(false)
  })
})
