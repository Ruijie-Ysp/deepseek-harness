# Agent Note: 编辑历史用户消息并从中重新生成

Status: implemented

[English](2026-08-20-user-message-edit-resubmit.md) | 中文

## 问题

Web 界面无法改写历史用户消息并重新提交：用户气泡只有复制操作，最接近的工作流是在助手消息处分叉（fork）并在子会话中继续——那是新会话，而非原地重新生成。追加式会话日志是唯一事实来源，因此原地改写需要一种持久表示：改变模型可见的 surface，同时不抹掉文本记录（transcript）。

## 决策

新增 surface 事件 `user/edit`（`{ message: UserMessage; replacesSeq: number }`）记录改写。agent 循环以 `surfaceOp: { op: 'replace', start: replacesSeq, end: currentTail }` 追加该事件，并用 `sourceEventSeqs` 列出所有被遮蔽的 surface 节点，于是 `Session.deriveMessages()` 从编辑后的消息重建模型历史，丢弃目标之后的一切——与 compaction 使用同一套 surface 机制。追加式文本记录保留原始用户消息、被取代的回复链以及编辑记录。

持久化的待办记录沿用现有 inbox 路径，与 prompt 完全一致：新 RPC `session.editPrompt` 校验目标（当前 surface 上投影人类用户消息的节点——`source.kind === 'user'` 的 append 源 `user/message`，或之前的 `user/edit`），并把改写作为普通 `next-turn` 消息插入 inbox，其 `source.replacesSeq`（api-proxy `user-rpc` source 增强上的字段）由持久的 `agent/inbox/spliced` 事件保存。接受与回合之间的崩溃可从 splice 重放待办改写，claim-once 语义防止重复追加 `user/edit`。循环在 claim 时（`turn/start` 之后）把标记转换为 `user/edit` 追加，因此改写归属新回合，且替换区间针对实时 surface 尾部计算（agent 运行期间排队的编辑同样遮蔽后续尾部）。

协议只接受文本内容，会话型 subagent 与 `updateQueue` 一样以 `agent-busy` 拒绝。不需要提升 `SESSION_FORMAT_VERSION`：`user/edit` 属于普通词汇增长，旧运行时按 session-log-version 机制对未知必读事件大声拒绝。

## 影响

- 界面在带文本的用户气泡（以及之前的编辑）上显示铅笔操作；点击进入输入框编辑模式（`inputActions.beginEdit` / `cancelEdit`）：草稿采纳消息文本，横幅提示改写，提交走 `session.editPrompt` 而非 `prompt`。纯图片（无文本）的气泡没有编辑入口——没有可改写的内容。
- 改写后的消息以带「已编辑」徽标的用户气泡渲染；被取代的文本记录仍可见于上方（诚实的追加式视图，与 UI 对持久日志的处理一致）。
- `session.editPrompt` 失败以作曲器通知呈现并保留草稿（与拒绝的 prompt 相同的 fail-soft 契约）。
- 一次改写只编辑文本，并按原序原样保留目标的非文本块（图片）——编辑带截图的消息会保留其截图。编辑路径不能新增图片内容；一次改写总是遮蔽目标之后的整个尾部。

## 备选方案

- **基于 fork 的工作流**——既有路径；创建独立会话且从不原地重新生成，正是本功能填补的缺口。
- **Host 在唤醒 agent 前持久追加 `user/edit`**——改写会在其回合之前进入日志，但 claim 路径随后需要在崩溃重放时去重，且无法在 claim 时计算替换区间。沿 inbox splice 走复用了 prompt 路径的崩溃安全与 claim-once 纪律。
- **原地视觉隐藏被取代的尾部**——纯呈现，暂缓：持久文本记录是事实来源，UI 已渲染 append 源事件，隐藏旧链属于独立的界面变更。
