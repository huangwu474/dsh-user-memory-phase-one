# Agent Note: User memory phase one — durable notepad and this-session overrides

Status: implemented

[English](2026-08-23-user-memory-phase-one.md) | 中文

## 问题

harness 没有一等能力让模型跨轮次和进程记住长期用户事实，也无法在不写入长期存储的情况下遵守仅本次覆盖。产品记忆因此无法按 ChatGPT 的记事本／仅本次覆盖拆分，除非另写插件。

## 决策

`@deepseek-ai/dsh-user-memory` 是位于 `packages/memory/user-memory/` 的单个函数插件。它是可选的，不在已发布默认组合里。加载它的组合必须已经提供 `ctx.storageDomain`。

插件打开域 `user_memory` 版本 1，只有一张表 `saved_memories`。记录为 `{ text, lastUpdateDate, createdAt }`，主键是带品牌的 `MemoryId`。新铸造的 id 是 12 位小写十六进制；`allocateMemoryId` 在 `table.get` 已占用时重试，有限次碰撞后抛错。磁盘上已有的 UUID 键仍然有效、可寻址。相同 `text` 更新已有行。当另一 id 已保存该文本时，`update_memory` 返回 `{ ok: false, error: 'duplicate_text' }`。仅本次覆盖放在以 `Agent` 为键的 `WeakMap` 里，永不写入该域。`maxSessionOverrides` 是 ≥ 1 的整数。

四个工具（`save_memory`、`update_memory`、`delete_memory`、`save_session_override`）注册到 `ctx.tools`。长期事实注入为 `- [<id>] <text>`，以便 `update_memory` 和 `delete_memory` 从快照抄写 id；策略段落说明这一点。`user-memory:policy` 是 order `-20` 的系统提示段落。`user-memory:session` 和 `user-memory:saved` 作为全局 `systemPrompt.context()` 贡献注册。仅本次覆盖的正文读取 `AssembleContext.agent`（与 `dsh-user-approval` 相同），并在以该 `Agent` 为键的 `WeakMap` 里查找。空列表不贡献内容。

仅本次覆盖不注册到 `agent.ctx`。子代理的 scoped `systemPrompt.context()` 能用，是因为子插件拥有那条 fiber；本插件不创建 agent，而注册到 `agent.ctx` 上的贡献会在本插件 fiber dispose 之后仍然存在，破坏 HMR 安全规则。全局注册加上 `context.agent` 会随插件 fiber 一起卸载。

不新增 `SessionEventMap` 成员。agent-loop 的 `preStep` 已经在拼接后的快照文本变化时，把 `systemPrompt.context()` 落成带源的 `user/message`（`plugin` 为 `@deepseek-ai/dsh-system-prompt`，`form: 'snapshot'`），工具执行已经记录 `tool/call` 和 `tool/result`。证据：`packages/core/system-prompt/src/index.ts` 中的 `joinContextSections` 会加上 `Current runtime context. This snapshot supersedes earlier runtime-context snapshots.` 前缀；`packages/core/agent-loop/src/runtime-context.ts` 中的 `RuntimeContextProjection.project` 只在该文本变化时返回带源的 user 消息；`packages/core/agent-loop/src/agent.ts` 中的 `preStep` 通过 `session.append('user/message', ...)` 把它追加在已声称的收件箱条目之后。

没有用户画像表，也没有最近对话归档。harness 没有可拥有离线合并过程的会话结束钩子，未使用的表也没有当前消费者。

## 考虑过的替代方案

**拆成 Service Definition / Provider / Consumer。** 拒绝，因为只有一个实现和一条消费路径。同样的取舍记录在 [`dsh-mcp-client`](2026-07-07-mcp-client-plugin.zh.md)。第二种记忆后端才值得再拆。

**把 `user-memory:session` 注册到每个 `agent.ctx`，让 scoped 贡献覆盖全局。** 拒绝，因为本插件并不拥有 agent fiber。注册到 `agent.ctx` 上的贡献会活过本插件的 dispose，HMR 安全测试会失败。`AssembleContext.agent` 加上 `WeakMap` 与 `dsh-user-approval` 一致。

**为注入的事实新增会话事件。** 拒绝，因为运行时上下文投影已经把快照追加为带源的 user 消息，第二条事件会重复模型可见输入。

**为合成画像和聊天历史归档留空位。** 拒绝，因为 `packages/AGENTS.md` 要求每个抽象都有当前所有者和需要。

**在长期记录上保留没有读取方或写入方的 `keywords` 或 `source`。** 因同一条所有者和需要规则而拒绝。`z.object()` 会剥离未知键，因此更早写入这些字段的行无需提升域版本即可加载。

**把 UUID 当作快照 id。** 拒绝，因为五十条事实大约会在 id 上花费 1800 个字符。带碰撞检查的 12 位十六进制 id 仍可从快照抄写。

**把 `maxSessionOverrides: 0` 当成静默关闭，同时让 `save_session_override` 仍返回 `ok`。** 拒绝：成功的工具结果永不注入，不是执行。该上限是 ≥ 1 的整数，配 0 时在加载时失败。

**照搬 ChatGPT Memory 的裸 XML 块（`<model_set_context>`）。** 拒绝，因为本运行时用 `Current runtime context. This snapshot supersedes earlier runtime-context snapshots.` 包装上下文，并在快照源上标注具名 section。

**把 `save_memory` 里的 “this trip” 文本自动改道到仅本次覆盖。** 拒绝：四个工具才是执行点；策略段落告诉模型该调哪个工具。

## 后果

需要记忆的组合必须列出存储中枢、KV 后端、storage-domain 和本插件。headless 和 CLI 的已发布补丁不含它们；web-app 补丁已经有存储栈，以后可以单独加本插件。若有第二阶段，必须先有真正的会话结束或维护钩子，才能再加表。

## 测试

包测试覆盖工具身份、文本去重、`duplicate_text`、重启后按快照 id 删除，以及带多余字段被剥离的 UUID 键的 update 和 delete。它们还覆盖 id 碰撞重试、上限、HMR 卸载，以及 JSON 后端重启。Loader 组合会启动一份真正的 `cordis.yml`。无密钥的 `user-memory` 快照在 `examples/headless-agent/tests/user-memory.snapshot.ts`，检查 `save_memory` 进入会话日志，以及随后的运行时上下文快照在 `- [id] text` 行上包含该事实。
