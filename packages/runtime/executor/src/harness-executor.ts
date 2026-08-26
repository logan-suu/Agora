import { appendMutation, type RoleSpec } from '@agora/core-domain';
import { Context, type Fiber } from '@deepseek-ai/cordis';
import AgentRegistry, { type Agent, type AgentHandle } from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic';
import LlmRuntime, { type LlmAdapter } from '@deepseek-ai/dsh-llm';
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm/message';
import * as LlmDeepseek from '@deepseek-ai/dsh-llm-deepseek';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import TokenMeter from '@deepseek-ai/dsh-token-meter';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import type { Executor, ProjectionView, StepContext, StepResult } from './base';

/** Default model name used when neither RoleSpec.model nor AGORA_MODEL is set. */
const DEFAULT_MODEL = 'deepseek-chat';

/** Provider name for a caller-registered adapter (tests inject a fake LLM here). */
const DEFAULT_PROVIDER = 'agora';

/** Provider route registered by {@link LlmDeepseek} for real DeepSeek calls. */
const DEEPSEEK_PROVIDER = 'deepseek-official';

/** Options for constructing a {@link HarnessExecutor}. */
export interface HarnessExecutorOptions {
  /** Optional LLM adapter registered under `provider` (tests inject a fake). */
  adapter?: LlmAdapter;
  /** Provider key the adapter is registered under. Defaults to `agora`. */
  provider?: string;
  /**
   * Load the real DeepSeek provider plugin (route `deepseek-official`).
   * The API key is read per-request from `apiKeyEnv` (default `DEEPSEEK_API_KEY`).
   */
  deepseek?: boolean | { apiKeyEnv?: string };
}

/**
 * Phase 0 thin executor (decisions D1/D2) over the DeepSeek Harness.
 *
 * The Harness loop is event-driven (there is no per-step `runStep` driver): we
 * compose the minimal Cordis plugin set, create one agent per session, and map
 * each `step()` to "send one followup input + await quiescence (`whenIdle`)".
 * The `agent/pre-step` hook overwrites the LLM input with the role projection
 * (decision D1), and `agent/request` fixes the model route. The assistant's
 * final message is lifted from the durable session log and emitted as a
 * `messages` append mutation (R1: shared State writes only via applyMutations).
 *
 * Layering note: this executor depends only on core-domain types (R8); the
 * orchestration layer's `buildExecutor(spec, assign)` callback supplies the
 * RoleSpec, so no cross-layer Assignment import is needed.
 */
export class HarnessExecutor implements Executor {
  private readonly ctx: Context;
  private readonly provider: string;
  private readonly adapter: LlmAdapter | undefined;
  private readonly pluginFibers: Fiber[] = [];
  private ready: Promise<void>;
  private handle: AgentHandle | null = null;
  private view: ProjectionView = { role: '', slices: {} };

  constructor(
    private readonly spec: RoleSpec,
    options: HarnessExecutorOptions = {},
  ) {
    this.ctx = new Context();
    // Minimal plugin set; load order respects each plugin's `inject` deps.
    this.pluginFibers.push(this.ctx.plugin(AgentRegistry)); // ctx.agents
    this.pluginFibers.push(this.ctx.plugin(SessionStore)); // ctx.sessions
    this.pluginFibers.push(this.ctx.plugin(LlmRuntime)); // ctx.llm
    this.pluginFibers.push(this.ctx.plugin(SystemPrompt)); // ctx.systemPrompt
    this.pluginFibers.push(this.ctx.plugin(ToolRuntime)); // ctx.tools (injects systemPrompt)
    this.pluginFibers.push(this.ctx.plugin(TokenMeter)); // ctx.tokenMeter (needed by compaction)
    this.pluginFibers.push(this.ctx.plugin(AgentLoop)); // registers the agents factory
    this.pluginFibers.push(this.ctx.plugin(BasicCompactionEngine)); // ctx.compaction (zero-config auto)
    if (options.deepseek !== undefined && options.deepseek !== false) {
      const apiKeyEnv =
        typeof options.deepseek === 'object' ? options.deepseek.apiKeyEnv : undefined;
      this.provider = DEEPSEEK_PROVIDER;
      this.pluginFibers.push(
        this.ctx.plugin(LlmDeepseek, apiKeyEnv === undefined ? {} : { apiKeyEnv }),
      );
    } else {
      this.provider = options.provider ?? DEFAULT_PROVIDER;
    }
    this.adapter = options.adapter;
    this.ready = this.awaitPlugins();
  }

  private async awaitPlugins(): Promise<void> {
    await Promise.all(this.pluginFibers);
    if (this.adapter !== undefined) {
      this.ctx.llm.registerAdapter([this.provider], this.adapter);
    }
  }

  /** One worker turn = one `step()`; resolves on turn quiescence (Phase 0 degenerate). */
  async step(context: StepContext): Promise<StepResult> {
    await this.ready;
    this.view = context.view;
    const agent = await this.ensureAgent(context.sessionId);

    // Wake the self-driving loop with the projection slice as this turn's input.
    agent.followup(this.projectionMessage());
    await agent.whenIdle();

    const text = lastAssistantText(agent);
    const mutations = text === null ? [] : [appendMutation('messages', this.toAgoraMessage(text))];
    return {
      kind: 'done',
      output: text === null ? {} : { text },
      reachedSafeBoundary: true,
      mutations,
    };
  }

  /** Phase 0 safe-point cursor: the live session id (decision D4 recovery seam). */
  async saveSafePoint(): Promise<string> {
    await this.ready;
    return String(this.handle?.agent.id ?? 'no-session');
  }

  /** Phase 0 no-op; real fork-recovery landing is task 8.1 (humanGate Terminate & Fork). */
  async loadSafePoint(_cursor: string): Promise<void> {
    // Interface-compliant placeholder (decision D4). Reconstructing a live agent
    // from the cursor lands in task 8.1.
  }

  /** Store the latest projection view; the next `agent/pre-step` re-projects from it. */
  injectInbox(view: ProjectionView): void {
    this.view = view;
  }

  /** Release the agent loop and tear down all loaded plugins (reverse order). */
  async dispose(): Promise<void> {
    await this.ready;
    await this.handle?.dispose();
    this.handle = null;
    for (let i = this.pluginFibers.length - 1; i >= 0; i -= 1) {
      await this.pluginFibers[i]?.dispose();
    }
  }

  private async ensureAgent(sessionId: string): Promise<Agent> {
    if (this.handle !== null) return this.handle.agent;
    const handle = await this.ctx.agents.create({
      sessionId: SessionId(sessionId),
      agentOptions: { provider: this.provider, model: this.resolveModel() },
      setup: (agentCtx) => {
        // Decision D1: overwrite the messages fed to the LLM with the projection.
        agentCtx.on('agent/pre-step', async () => ({
          kind: 'enter',
          messages: [this.projectionMessage()],
        }));
        // Model routing: fix the provider/model from RoleSpec or env.
        agentCtx.on('agent/request', async (_payload, next) => {
          const config = await next();
          return { ...config, provider: this.provider, model: this.resolveModel() };
        });
      },
    });
    this.handle = handle;
    return handle.agent;
  }

  private resolveModel(): string {
    return this.spec.model ?? process.env.AGORA_MODEL ?? DEFAULT_MODEL;
  }

  /** Serialize the current projection view into a single user message. */
  private projectionMessage(): UserMessage {
    return createUserMessage({
      content: [{ type: 'text', text: JSON.stringify(this.view) }],
      source: { kind: 'plugin', plugin: 'agora' },
    });
  }

  private toAgoraMessage(text: string) {
    return {
      msgId: crypto.randomUUID(),
      channelId: 'main',
      fromRole: this.spec.role,
      type: 'chat' as const,
      payload: {},
      display: text,
      ts: Date.now(),
    };
  }
}

/** Extract the last assistant text block from the durable session log. */
function lastAssistantText(agent: Agent): string | null {
  for (let i = agent.session.events.length - 1; i >= 0; i -= 1) {
    const event = agent.session.events[i];
    if (event?.type === 'assistant/message') {
      const message = (event.data as { message?: { content: unknown[] } }).message;
      if (message === undefined) continue;
      for (let j = message.content.length - 1; j >= 0; j -= 1) {
        const block = message.content[j] as { type?: string; text?: string } | undefined;
        if (block?.type === 'text' && typeof block.text === 'string' && block.text !== '') {
          return block.text;
        }
      }
    }
  }
  return null;
}
