#!/usr/bin/env node
/** Snapshot-only Loader driver: run one prompt turn, then rewrite it with an edit turn. */

import type { Context } from '@deepseek-ai/cordis'
import { boot, installFailLoud, loadEnv, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

const NAME = 'headless-edit-driver'
const [configPath, ...taskParts] = process.argv.slice(2)
if (configPath === undefined || taskParts.length === 0 || taskParts.every(part => part.trim() === '')) {
  throw new Error(`${NAME}: expected <config-path> <task...>`)
}

const uninstallFailLoud = installFailLoud(NAME)
let ctx: Context | undefined
try {
  loadEnv(NAME)
  ctx = await boot(NAME, resolveConfigPath(configPath, undefined))
  const agents = ctx.get('agents')?.roots() ?? []
  const [agent] = agents
  if (agent === undefined || agents.length !== 1) {
    throw new Error(`${NAME}: exactly one root agent required, found ${agents.length}`)
  }

  await agent.whenIdle()
  // Turn 1: the original human prompt.
  const original = createUserMessage({
    content: [{ type: 'text', text: taskParts.join(' ') }],
    source: { kind: 'user' },
  })
  let output = ''
  let received = false
  const disposeListener = ctx.on('session/event', (session, event) => {
    if (session !== agent.session) return
    if (!received) {
      if (event.type !== 'agent/inbox/spliced') return
      if (!event.data.inserted.some(inserted => inserted.id === original.id)) return
      received = true
    }
    process.stdout.write(`${JSON.stringify({ type: 'session_event', sessionId: session.id, event })}\n`)
    if (event.type === 'assistant/message') {
      const text = event.data.message.content
        .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
        .map(block => block.text)
        .join('')
      if (text !== '') output = text
    }
  })

  agent.followup(original)
  await agent.whenIdle()

  // Turn 2: rewrite the durable user message. This is the exact durable intent
  // the session.editPrompt RPC queues: the rewrite target rides the source, and
  // the loop turns it into a `user/edit` append shadowing the target and tail.
  const userSeq = agent.session.events.find(event => event.type === 'user/message')?.seq
  if (userSeq === undefined) throw new Error(`${NAME}: no durable user message after the first turn`)
  const edited = createUserMessage({
    content: [{ type: 'text', text: `Edited: ${taskParts.join(' ')}` }],
    // The rewrite target rides the durable source, exactly as the api-proxy's
    // session.editPrompt queues it. `as never` keeps the example program from
    // depending on the apiproxy's `user-rpc` source augmentation.
    source: { kind: 'user', replacesSeq: userSeq } as never,
  })
  agent.followup(edited)
  await agent.whenIdle()

  disposeListener()
  await ctx.sessions.flush(agent.session)
  process.stdout.write(`${JSON.stringify({ type: 'result', sessionId: agent.session.id, output })}\n`)
} catch (error: unknown) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
} finally {
  await ctx?.fiber.dispose()
  uninstallFailLoud()
}
