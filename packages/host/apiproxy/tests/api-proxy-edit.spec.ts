/**
 * session.editPrompt: rewriting one durable user message and regenerating the
 * conversation from it. Target validation (surface membership and user-role
 * projection), time-zone canonicalization, and the queued rewrite source.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { createApiProxy } from '../src/api-proxy.ts'

const sid = (id: string): SessionId => id as SessionId

let nextRpc = 1
function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`edit-${String(nextRpc++)}`), payload }
}

async function harness(): Promise<{
  ctx: Context
  agent: Agent
  sessionId: SessionId
  followup: ReturnType<typeof vi.fn>
}> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(UserQuestionService)
  const session = ctx.sessions.create(sid('session-edit'), { meta: { cwd: '/proj' } })
  // One completed human turn: a durable user message at seq 1 (turn/start 0).
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'original' }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn: 1, step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'reply' }],
      source: { kind: 'model', ...{ provider: 'mock', model: 'mock' } },
    }),
  }, { surfaceOp: 'append' })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const followup = vi.fn()
  const agent = { id: session.id, session, status: 'idle', ctx, followup } as unknown as Agent
  ctx.agents.register(agent)
  return { ctx, agent, sessionId: session.id, followup }
}

function apiOf(ctx: Context): ReturnType<typeof createApiProxy> {
  return createApiProxy(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })
}

describe('sessions.editPrompt', () => {
  it('queues a rewrite whose durable source carries the target seq and canonical zone', async () => {
    const { ctx, sessionId, followup } = await harness()
    const api = apiOf(ctx)
    const alias = 'US/Pacific'
    const canonical = new Intl.DateTimeFormat('en-US', { timeZone: alias })
      .resolvedOptions().timeZone
    const editRequest = request({
      sessionId,
      atSeq: 1,
      content: [{ type: 'text' as const, text: 'rewritten' }],
      clientTimeZone: alias,
    })
    const result = await api.sessions.editPrompt(editRequest)
    expect(result.result).toEqual({ ok: true, value: { accepted: true } })
    expect(followup).toHaveBeenCalledTimes(1)
    const queued = followup.mock.calls[0]?.[0] as UserMessage
    expect(queued.content).toEqual([{ type: 'text', text: 'rewritten' }])
    expect(queued.source).toEqual({
      kind: 'user',
      rpcId: editRequest.rpcId,
      clientTimeZone: canonical,
      replacesSeq: 1,
    })
  })

  it('rejects a seq that is not a current surface node', async () => {
    const { ctx, sessionId, followup } = await harness()
    const api = apiOf(ctx)
    const result = await api.sessions.editPrompt(request({
      sessionId,
      atSeq: 9999,
      content: [{ type: 'text' as const, text: 'rewritten' }],
    }))
    expect(result.result.ok).toBe(false)
    if (!result.result.ok) {
      expect(result.result.error.code).toBe('edit-target-invalid')
      expect(result.result.error.details).toEqual({ atSeq: 9999 })
    }
    expect(followup).not.toHaveBeenCalled()
  })

  it('rejects a surface node that does not project a human user message', async () => {
    const { ctx, sessionId, followup } = await harness()
    const api = apiOf(ctx)
    // The assistant/message surface node at seq 2 is not a user rewrite target.
    const result = await api.sessions.editPrompt(request({
      sessionId,
      atSeq: 2,
      content: [{ type: 'text' as const, text: 'rewritten' }],
    }))
    expect(result.result.ok).toBe(false)
    if (!result.result.ok) expect(result.result.error.code).toBe('edit-target-invalid')
    expect(followup).not.toHaveBeenCalled()
  })

  it('rejects an invalid browser time zone before touching the agent', async () => {
    const { ctx, sessionId, followup } = await harness()
    const api = apiOf(ctx)
    const result = await api.sessions.editPrompt(request({
      sessionId,
      atSeq: 1,
      content: [{ type: 'text' as const, text: 'rewritten' }],
      clientTimeZone: 'Not/A_Real_Zone',
    }))
    expect(result.result.ok).toBe(false)
    if (!result.result.ok) {
      expect(result.result.error.code).toBe('invalid-time-zone')
      expect(result.result.error.details).toEqual({ value: 'Not/A_Real_Zone' })
    }
    expect(followup).not.toHaveBeenCalled()
  })

  it('preserves the target non-text blocks when queuing a rewrite', async () => {
    const { ctx, agent, sessionId, followup } = await harness()
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
    const api = apiOf(ctx)

    const result = await api.sessions.editPrompt(request({
      sessionId,
      atSeq: imageSeq!,
      content: [{ type: 'text' as const, text: 'fixed caption' }],
    }))
    expect(result.result).toEqual({ ok: true, value: { accepted: true } })
    const queued = followup.mock.calls[0]?.[0] as UserMessage
    expect(queued.content).toEqual([
      { type: 'text', text: 'fixed caption' },
      { type: 'image', attachment: { attachmentId: 'att-1', mediaType: 'image/png', bytes: 1, width: 1, height: 1 } },
    ])
  })
})
