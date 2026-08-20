#!/usr/bin/env node
/** Test driver that sends one image-carrying turn through a Headless Loader composition. */

import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('ocr-preprocess driver requires a config path')

const ctx = await boot('ocr-preprocess-e2e', resolveConfigPath(configPath, undefined))
try {
  const agents = ctx.get('agents')?.roots() ?? []
  const [agent] = agents
  if (agent === undefined || agents.length !== 1) {
    throw new Error('ocr-preprocess fixture requires exactly one top-level agent')
  }
  await agent.whenIdle()
  agent.followup(createUserMessage({
    content: [
      { type: 'text', text: 'read this image' },
      {
        type: 'image',
        attachment: {
          attachmentId: 'fixture-image' as never,
          mediaType: 'image/png',
          bytes: 69,
          width: 1,
          height: 1,
        },
      },
    ],
    source: { kind: 'user' },
  }))
  await agent.whenIdle()
} finally {
  await ctx.fiber.dispose()
}
