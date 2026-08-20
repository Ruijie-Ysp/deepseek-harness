# Agent Note: Editing a historical user message and regenerating from it

Status: implemented

English | [中文](2026-08-20-user-message-edit-resubmit.zh.md)

## Problem

The Web GUI offered no way to rewrite a past user message and resubmit it: user bubbles carried copy only, and the closest workflow was forking at an assistant message and continuing in a child session — a new session, not an in-place regeneration. The append-only session log is the single source of truth, so an in-place rewrite needs a durable representation that changes the model-visible surface without erasing the transcript.

## Decision

A new surface-eligible session event `user/edit` (`{ message: UserMessage; replacesSeq: number }`) records the rewrite. The agent loop logs it with `surfaceOp: { op: 'replace', start: replacesSeq, end: currentTail }` and `sourceEventSeqs` listing every shadowed surface node, so `Session.deriveMessages()` rebuilds model history from the edited message and drops everything after the target — the same surface mechanism compaction uses. The append-only transcript keeps the original user message, the superseded reply chain, and the edit record.

The durable pending record rides the existing inbox path, exactly like a prompt: the new RPC `session.editPrompt` validates the target (a current surface node projecting a human user message — an append-origin `user/message` with `source.kind === 'user'`, or a prior `user/edit`) and inserts the rewrite as an ordinary `next-turn` message whose `source.replacesSeq` (a field on the api-proxy's `user-rpc` source augmentation) is preserved by the durable `agent/inbox/spliced` event. A crash between acceptance and the turn replays the pending rewrite from the splice, and the claim-once semantics prevent a duplicate `user/edit` append. The loop turns the marker into the `user/edit` append at claim time, after `turn/start`, so the rewrite belongs to the new turn and the replace range is computed against the live surface tail (an edit queued while the agent runs shadows the later tail too).

The protocol accepts text content only, and session-backed subagents reject with `agent-busy` like `updateQueue`. No `SESSION_FORMAT_VERSION` bump: `user/edit` is ordinary vocabulary growth, and an old reader refuses the unknown required event loudly per the session-log-version mechanism.

## Consequences

- The GUI shows a pencil action on text-bearing user bubbles (and prior edits); clicking it enters composer edit mode (`inputActions.beginEdit` / `cancelEdit`): the draft adopts the message text, a banner announces the rewrite, and submit routes through `session.editPrompt` instead of `prompt`. A bubble with no text (image-only) offers no edit — there is nothing to rewrite.
- The rewritten message renders as a user bubble with an `已编辑` badge; the superseded transcript remains visible above (honest append-only view, matching how the UI treats the durable log).
- `session.editPrompt` failure surfaces as a composer notice with the draft retained (the same fail-soft contract as a rejected prompt).
- A rewrite edits the text and preserves the target's non-text blocks (images) verbatim, in original order after the new text — editing a screenshot-bearing message keeps its screenshots. New image content cannot be added through the edit path; a rewrite always shadows the whole tail after the target.

## Alternatives considered

- **Fork-based workflow** — the pre-existing path; creates a separate session and never regenerates in place, which is exactly the gap this feature closes.
- **Host-side durable `user/edit` append before waking the agent** — the rewrite would be in the log before its turn, but the claim path would then need duplicate-suppression on crash replay and could not compute the replace range at claim time. Riding the inbox splice reuses the prompt path's crash safety and claim-once discipline.
- **In-place visual suppression of the superseded tail** — presentation-only, deferred: the durable transcript is the source of truth and the UI already renders append-origin events, so hiding the old chain would be a separate surface change.
