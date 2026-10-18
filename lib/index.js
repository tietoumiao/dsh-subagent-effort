/**
 * dsh-subagent-effort — choose a subagent's `reasoningEffort` PER CALL.
 *
 * WHERE THE EFFORT ACTUALLY TRAVELS
 * ---------------------------------
 * `reasoningEffort` is a first-class PER-REQUEST field of the subagent seam, not
 * a per-model profile entry and not a preset-level value:
 *
 *   - `SubagentStartRequest.agentOptions` = "provider, model, reasoning-effort
 *     and output-token overrides" (requires `SubagentCapabilities.agentOptions`).
 *   - `resolveChildAgentOptions(parent, requested, depth)` spreads `requested`
 *     over the parent route and only drops an inherited effort when the route
 *     changed AND no effort was requested — so an explicit effort survives both
 *     model inheritance and a model switch.
 *   - `dsh-llm` validates the chosen effort against the model's advertised
 *     `reasoning.efforts` before any I/O (`UNSUPPORTED_REASONING_EFFORT`).
 *
 * So the plugin registers one tiny LOCAL provider (`prepareContinuable`, the
 * 0.2.1 activation contract) that advertises `agentOptions` and lets the host
 * materialize the child with `request.agentOptions.reasoningEffort`. The child
 * otherwise joins its parent's preset, exactly like the stock subagent tool:
 * no preset is invented or mounted here.
 */

import { assertUsableCwd } from '@deepseek-ai/dsh-subagent'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dsh-subagent-effort'
export const inject = ['subagents', 'tools']

/** The effort ids this tool accepts (the host validates them per model). */
const EFFORTS = ['low', 'high', 'max']

function messageOf(error) {
  return error instanceof Error && error.message ? error.message : String(error)
}

/**
 * LOCAL provider for the 0.2.1 activation backend. The manager takes the
 * `startLocal` path when `prepareContinuable` exists, materializes the child
 * itself and applies `request.agentOptions` (including `reasoningEffort`)
 * through `resolveChildAgentOptions`. No child is created here.
 */
function createProvider(providerName) {
  return {
    name: providerName,
    capabilities: { agentOptions: true, outputSchema: false, depthLimit: true, toolFilter: false, persona: false },
    inheritsParentContext: false,
    async prepareContinuable(request) {
      if (request?.signal?.aborted) throw new Error(`${providerName}: request aborted before the child was prepared`)
      // No seed: the child starts with an empty conversation.
      return {}
    },
  }
}

export function apply(ctx, config = {}) {
  const providerName = config.providerName ?? 'subagent-effort'
  const toolName = config.toolName ?? 'subagent_effort'
  const provider = createProvider(providerName)
  if (ctx.subagents.getProvider(providerName) === undefined) {
    ctx.subagents.registerProvider(provider)
  } else {
    ctx.logger?.info?.(`${name}: provider "${providerName}" already registered; skipping duplicate`)
  }

  ctx.effect(() => ctx.tools.register(defineTool({
    name: toolName,
    description: 'Run a ONE-SHOT subagent with an explicitly chosen thinking intensity (reasoningEffort). '
      + 'Unlike the stock subagent tools, this call carries `effort` = low | high | max for THIS child only; '
      + 'the child inherits your model/preset otherwise (pass `model` to switch model, `cwd` to change workspace). '
      + 'Waits for the child and returns its final output. Fails loudly when the chosen model does not support that effort.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'The complete, self-contained task for the subagent. It does not share this conversation\'s context, so include everything it needs.' },
      effort: { type: 'string', required: true, enum: EFFORTS, description: 'Thinking intensity for this child ONLY: "low", "high", or "max". Validated against the model\'s advertised efforts; an unsupported value fails with the supported list.' },
      cwd: { type: 'string', description: 'Optional absolute working directory for the child (must be an existing directory). Omit to inherit this session\'s cwd.' },
      model: { type: 'string', description: 'Optional model id the child should use, under the same provider as this session. Omit to inherit this session\'s model.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          effort: { type: 'string', required: true },
          model: { type: 'string' },
          stopReason: { type: 'string', required: true },
          output: { type: 'array', items: { type: 'json' } },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `[subagent_effort effort=${value.effort}${value.model ? ` model=${value.model}` : ''} | ${value.stopReason}]\n`
          + (value.output ?? []).filter((b) => b && b.type === 'text').map((b) => b.text).join(''),
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const parent = exec.agent
      if (!parent) throw new Error(`${toolName}: requires a calling agent (exec.agent was undefined)`)
      if (!EFFORTS.includes(args.effort)) {
        throw new Error(`${toolName}: effort must be one of ${EFFORTS.join(' | ')}, got ${JSON.stringify(args.effort)}`)
      }
      const effort = args.effort
      const cwd = args.cwd === undefined || args.cwd === '' ? undefined : assertUsableCwd(toolName, 'cwd', args.cwd)
      const agentOptions = { reasoningEffort: effort }
      if (args.model !== undefined && args.model !== '') agentOptions.model = args.model

      // Fail before delegation with a readable error when the route cannot honour
      // this effort (or the model id is unknown). Mirrors dsh-llm's own validation.
      const live = parent.session.requestHeader()?.config
      const provider = live?.provider ?? parent.options?.provider
      const model = args.model ?? live?.model ?? parent.options?.model
      const llm = ctx.get('llm')
      if (llm !== undefined && typeof llm.resolveModelInfo === 'function' && provider !== undefined && model !== undefined) {
        let info
        try {
          info = await llm.resolveModelInfo(provider, model)
        } catch (cause) {
          let available = '(none)'
          try {
            const models = await llm.listModels(provider)
            if (Array.isArray(models) && models.length > 0) available = models.map((m) => m.name ?? m.id).join(', ')
          } catch { /* keep '(none)' */ }
          throw new Error(`${toolName}: model "${model}" is not available under provider "${provider}"; available: ${available}`, { cause })
        }
        const efforts = info?.reasoning?.efforts
        if (!Array.isArray(efforts) || efforts.length === 0) {
          throw new Error(`${toolName}: provider "${provider}" model "${model}" declares no reasoning-effort support, so effort "${effort}" cannot be set — use the stock subagent tools for this model`)
        }
        if (!efforts.some((e) => e.id === effort)) {
          throw new Error(`${toolName}: provider "${provider}" model "${model}" does not support effort "${effort}"; supported: ${efforts.map((e) => e.id).join(', ')}`)
        }
      }

      if (typeof ctx.subagents.startActivation !== 'function') {
        throw new Error(`${toolName}: this host exposes no activation API (ctx.subagents.startActivation is undefined) — DSH 0.2.1 or newer is required`)
      }

      // Budget: exactly ONE level below this caller, never below its own parent.
      const parentDepth = parent.session.header?.delegationDepth ?? 0
      const maxDepth = parentDepth + 1

      let run
      try {
        run = await ctx.subagents.startActivation({
          provider: providerName,
          label: `effort:${effort}`,
          signal: exec.signal,
          // One-shot: the tool result carries the outcome, so suppress the
          // host's settlement notice to the parent's inbox.
          delivery: 'caller',
          request: {
            maxDepth,
            parent,
            prompt: [{ type: 'text', text: args.prompt }],
            agentOptions,
            ...(cwd === undefined ? {} : { cwd }),
          },
        })
      } catch (cause) {
        throw new Error(`${toolName}: could not start the effort="${effort}" subagent: ${messageOf(cause)}`, { cause })
      }

      // Foreground ownership: settle the RESULT first, then dispose. dispose()
      // cancels synchronously, so racing it against result would skip the turn.
      const [execution] = await Promise.allSettled([run.result])
      const [disposal] = await Promise.allSettled([Promise.resolve().then(() => run.dispose())])
      if (execution.status === 'rejected') {
        if (disposal.status === 'rejected') throw new AggregateError([execution.reason, disposal.reason], `${toolName}: run failed and dispose also failed`)
        throw new Error(`${toolName}: subagent run failed: ${messageOf(execution.reason)}`, { cause: execution.reason })
      }
      if (disposal.status === 'rejected') ctx.logger?.warn?.(`${toolName}: dispose failed for ${run.childId}: ${messageOf(disposal.reason)}`)
      const result = execution.value
      if (result.stopReason !== 'completed' && result.stopReason !== 'aborted') {
        const text = (result.output ?? []).filter((b) => b && b.type === 'text').map((b) => b.text).join('')
        const modelHint = args.model !== undefined && args.model !== '' ? ` [requested model=${args.model}; if unavailable, omit model to inherit the parent model]` : ''
        throw new Error(`${toolName}: subagent run ended with ${result.stopReason}${modelHint}${text.length > 0 ? `\nPartial output before the run ended:\n${text}` : ''}`)
      }
      return {
        effort,
        ...(args.model !== undefined && args.model !== '' ? { model: args.model } : {}),
        stopReason: result.stopReason,
        output: result.output ?? [],
      }
    },
  })), 'dsh-subagent-effort tool')
}
