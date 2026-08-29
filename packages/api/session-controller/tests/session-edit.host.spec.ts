/**
 * session.editPrompt: rewriting one durable user message and regenerating the
 * conversation from it. Target validation (surface membership and user-role
 * projection), time-zone canonicalization, and the queued rewrite source.
 */

import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionId as SessionIdType } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import { SessionCommandController } from '../src/commands.ts'
import type { SessionEditPromptRequest } from '../src/types.ts'

const sid = (id: string): SessionIdType => SessionId(id)

let nextRpc = 1
function request(payload: Omit<SessionEditPromptRequest, 'requestId'>): SessionEditPromptRequest {
  return { requestId: `edit-${String(nextRpc++)}` as SessionEditPromptRequest['requestId'], ...payload }
}

async function harness(): Promise<{
  ctx: Context
  agent: Agent
  sessionId: SessionIdType
  followup: ReturnType<typeof vi.fn>
  controller: SessionCommandController
}> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  const session = ctx.sessions.create(sid('session-edit'), { meta: { cwd: '/proj' } })
  // One completed human turn: a durable user message at seq 1 after turn/start.
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'original' }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn: 1, step: 1,
    message: createAssistantMessage({
      content: [{ type: 'text', text: 'reply' }],
      source: { provider: 'mock', model: 'mock' },
    }),
  }, { surfaceOp: 'append' })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const followup = vi.fn()
  const agent = { id: session.id, session, status: 'idle', ctx, followup } as unknown as Agent
  ctx.agents.register(agent)
  const controller = new SessionCommandController(ctx, {
    resolveAgent: () => Promise.resolve({ agent }),
  } as never, '/tmp')
  return { ctx, agent, sessionId: session.id, followup, controller }
}

describe('session.editPrompt', () => {
  it('queues a rewrite whose durable source carries the target seq and canonical zone', async () => {
    const { ctx, sessionId, followup, controller } = await harness()
    const alias = 'US/Pacific'
    const canonical = new Intl.DateTimeFormat('en-US', { timeZone: alias })
      .resolvedOptions().timeZone
    const editRequest = request({
      sessionId,
      atSeq: 1,
      content: [{ type: 'text', text: 'rewritten' }],
      clientTimeZone: alias,
    })
    await expect(controller.editPrompt(editRequest)).resolves.toEqual({ accepted: true })
    expect(followup).toHaveBeenCalledTimes(1)
    const queued = followup.mock.calls[0]?.[0] as UserMessage
    expect(queued.content).toEqual([{ type: 'text', text: 'rewritten' }])
    expect(queued.source).toEqual({
      kind: 'user',
      rpcId: editRequest.requestId,
      clientTimeZone: canonical,
      replacesSeq: 1,
    })
    await ctx.fiber.dispose()
  })

  it('rejects a seq that is not a current surface node', async () => {
    const { ctx, sessionId, followup, controller } = await harness()
    await expect(controller.editPrompt(request({
      sessionId,
      atSeq: 9999,
      content: [{ type: 'text', text: 'rewritten' }],
    }))).rejects.toMatchObject({ failure: { code: 'edit-target-invalid', details: { atSeq: 9999 } } })
    expect(followup).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('rejects a surface node that does not project a human user message', async () => {
    const { ctx, sessionId, followup, controller } = await harness()
    // The assistant/message surface node is not a user rewrite target.
    await expect(controller.editPrompt(request({
      sessionId,
      atSeq: 2,
      content: [{ type: 'text', text: 'rewritten' }],
    }))).rejects.toMatchObject({ failure: { code: 'edit-target-invalid' } })
    expect(followup).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('rejects an invalid browser time zone before touching the agent', async () => {
    const { ctx, sessionId, followup, controller } = await harness()
    await expect(controller.editPrompt(request({
      sessionId,
      atSeq: 1,
      content: [{ type: 'text', text: 'rewritten' }],
      clientTimeZone: 'Not/A_Real_Zone',
    }))).rejects.toMatchObject({
      failure: { code: 'invalid-time-zone', details: { value: 'Not/A_Real_Zone' } },
    })
    expect(followup).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('preserves the target non-text blocks when queuing a rewrite', async () => {
    const { ctx, agent, sessionId, followup, controller } = await harness()
    // A second user message carrying a durable image.
    agent.session.append('user/message', createUserMessage({
      content: [
        { type: 'text', text: 'look at this' },
        { type: 'image', attachment: { attachmentId: 'att-1', mediaType: 'image/png', bytes: 1, width: 1, height: 1 } },
      ] as never,
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const imageSeq = [...agent.session.events].reverse()
      .find(event => event.type === 'user/message')?.seq
    expect(imageSeq).toBeDefined()

    await expect(controller.editPrompt(request({
      sessionId,
      atSeq: imageSeq!,
      content: [{ type: 'text', text: 'fixed caption' }],
    }))).resolves.toEqual({ accepted: true })
    const queued = followup.mock.calls[0]?.[0] as UserMessage
    expect(queued.content).toEqual([
      { type: 'text', text: 'fixed caption' },
      { type: 'image', attachment: { attachmentId: 'att-1', mediaType: 'image/png', bytes: 1, width: 1, height: 1 } },
    ])
    await ctx.fiber.dispose()
  })
})
