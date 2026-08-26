# memory/ — user notepad

English | [中文](README.zh.md)

Opt-in durable user facts and this-session overrides. One product package because there is a single implementation and a single consumption path.

| Package | Role | ctx key |
|---|---|---|
| [`user-memory/`](user-memory/README.md) | Durable notepad plus this-session overrides | (registers on `ctx.tools` and `ctx.systemPrompt`) |

The child README owns tools, storage, and injection.
