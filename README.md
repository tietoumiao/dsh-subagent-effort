# dsh-subagent-effort

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that gives you **per-call control over a subagent's thinking intensity**.

The stock `subagent` / `subagent_fork` tools make the child inherit the session's `reasoningEffort`. This plugin adds one tool — `subagent_effort(prompt, effort, cwd?, model?)` — that runs a **one-shot** child with `effort = low | high | max` for that call only. The child otherwise joins your preset like a stock subagent: same persona, prompt sections, skill catalog and tools.

```text
subagent_effort(prompt="List the files under src/", effort="low")      # mechanical work, cheap
subagent_effort(prompt="Refactor this module and explain the risks", effort="max")
```

## Why it works

`reasoningEffort` is a first-class **per-request** field of the subagent seam, not a profile or preset setting:

- `SubagentStartRequest.agentOptions` documents provider / model / reasoning-effort / output-token overrides and requires the provider's `agentOptions` capability.
- The host's `resolveChildAgentOptions(parent, requested, depth)` spreads the requested options over the parent's route; an explicit effort survives both inheritance and a model switch.
- The LLM layer validates the effort against the model's advertised `reasoning.efforts` **before** any request and rejects unsupported values (`UNSUPPORTED_REASONING_EFFORT`) — no clamping, no silent fallback.

The plugin therefore registers one small provider implementing the 0.2.1 **local activation** contract (`prepareContinuable`) and advertises `agentOptions: true`. The host materializes the child, mounts the parent's preset composition and applies the requested effort. The plugin also pre-checks the model/effort pair through the `llm` service so a bad combination fails with a readable message instead of an opaque child error.

## Requirements

- DeepSeek Harness **0.2.1** or newer (the activation API `ctx.subagents.startActivation` is mandatory).
- Node.js 22+ (the host ships its own runtime; this is only for `node --check`).
- A model that advertises reasoning efforts. With the DeepSeek account provider, `deepseek-flash` advertises `low` / `high` / `max`.

## Install

From your DSH profile directory (for the desktop app: `%USERPROFILE%\.dsh\profiles\desktop`):

1. Add the dependency to `package.json`:

   ```json
   "dependencies": {
     "dsh-subagent-effort": "file:C:/path/to/dsh-subagent-effort"
   }
   ```

   A published tarball or git URL works the same way (`npm:` / `git+https:` specifier).

2. Append the bundle so the plugin is mounted with the profile:

   ```json
   "dsh": { "profile": { "bundles": [ "...", "dsh-subagent-effort" ] } }
   ```

3. Install and restart the app:

   ```powershell
   pnpm install
   ```

> Plugins are loaded at host startup — a restart is required after installing or updating. If you edit the plugin source in place, remember that a `file:` dependency is **copied** into `node_modules`, so re-run `pnpm install` (or copy the files) before restarting.

## Configuration

The plugin reads its settings from the bundle row (all optional):

| option | default | meaning |
|---|---|---|
| `providerName` | `subagent-effort` | provider name registered on `ctx.subagents` |
| `toolName` | `subagent_effort` | name of the model-facing tool |

```yaml
- id: dsh-subagent-effort
  name: dsh-subagent-effort
  config:
    toolName: subagent_effort
```

## Tool

| parameter | required | description |
|---|---|---|
| `prompt` | yes | Self-contained task for the child. It does **not** see this conversation. |
| `effort` | yes | `low` \| `high` \| `max`, validated against the model's advertised efforts. |
| `model` | no | Model id for the child (same provider as this session). Omit to inherit. |
| `cwd` | no | Absolute working directory for the child. Omit to inherit the session's. |

The call is **foreground**: it waits for the child and returns its final text. Use `low` for mechanical, deterministic work (run a command, read files, apply a template), `high` for judgment without long reasoning chains, and `max` for cross-file reasoning, source-level diagnosis or design trade-offs.

## How it works (implementation notes)

- `apply()` registers a provider implementing `prepareContinuable` — the host's local backend. No child agent is created by the plugin; the host materializes it and applies `request.agentOptions`.
- The tool builds `{ provider, label, signal, delivery: 'caller', request: { maxDepth, parent, prompt, agentOptions, cwd? } }` and awaits `ctx.subagents.startActivation(spec)`.
- `delivery: 'caller'` keeps the host from pushing a settlement notice into the parent's inbox — the tool result is the only delivery channel for a one-shot call.
- `maxDepth` is `parentDepth + 1`, so the child may not delegate further while a nested caller still works.
- Result first, dispose second: detaching the child before settling the result would cancel the turn.

## Verified vs. not verified

Verified on DSH `0.2.1-rc.1` / `0.2.1-rc.2` (Windows desktop, 2026-10-17/18):

- the tool registers and appears in the tool surface;
- `subagent_effort(effort="low")` returns `completed` with the child's text;
- the child session records `config.reasoningEffort: "low"` (`effort="max"` likewise); the ids are `48d6d4fe-…` (`low`) and `02d17f6e-…` (`max`);
- an unsupported effort or an unknown model fails before delegation with the supported list.

Not verified:

- `high` was not separately recorded in a child session log (the value is accepted and goes through the same validation path).
- Only the Windows desktop host was exercised; other shells/hosts are untested.
- The tool is foreground-only; there is no background/job mode (use your host's background delegation for that).

## License

MIT © 2026 tietoumiao
