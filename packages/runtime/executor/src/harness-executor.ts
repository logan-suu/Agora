import { createHash } from 'node:crypto';

import {
  appendMutation,
  type Mutation,
  mergeByIdMutation,
  type RoleSpec,
  setMutation,
  type TestResults,
} from '@agora/core-domain';
import { Context, type Fiber } from '@deepseek-ai/cordis';
import AgentRegistry, { type Agent, type AgentHandle } from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic';
import LlmRuntime, { type LlmAdapter } from '@deepseek-ai/dsh-llm';
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm/message';
import * as LlmDeepseek from '@deepseek-ai/dsh-llm-deepseek';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import TokenMeter from '@deepseek-ai/dsh-token-meter';
import {
  apply as applyToolCallTimeoutPolicy,
  inject as toolCallTimeoutPolicyInject,
  name as toolCallTimeoutPolicyName,
} from '@deepseek-ai/dsh-tool-call-timeout-policy';
import ToolRuntime, { type ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { Executor, ProjectionView, StepContext, StepResult } from './base';

/** Default model name used when neither RoleSpec.model nor AGORA_MODEL is set. */
const DEFAULT_MODEL = 'deepseek-v4-flash';

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
  /**
   * Phase 0 function tools (decision D5 / spec §9: fs + sandbox.run) registered
   * on this executor's ToolRuntime after plugins settle. Tool names match the
   * RoleSpec.tools whitelist verbatim; the composition root filters per role.
   */
  tools?: readonly ToolDefinition[];
  /**
   * Role tool whitelist (task 1.5): the wire-safe tool names resolved from
   * `RoleSpec.tools` via the tool catalog. When set, the agent's scoped ctx is
   * restricted to these names (`agentCtx.tools.restrict({ allow })` — the
   * Phase 1 equivalent of the subagent `toolFilter`; subagents land Phase 9).
   * An empty array hides every global tool (tool-less roles like COORDINATOR).
   */
  allowTools?: readonly string[];
  /**
   * Pre-dispatch approval gate (task 1.5, Phase 8 humanGate seam). Evaluated on
   * `tools/pre-execute` before each tool call. Return `allow` (or omit) to
   * proceed, `deny` to turn the call into a denial error visible to the model.
   */
  approval?: (exec: {
    name: string;
    arguments: unknown;
  }) => Promise<{ kind: 'allow' } | { kind: 'deny'; reason: string } | undefined>;
  /**
   * Per-turn tool-call budget (task 1.5 rate limiting, enforced by a monotonic
   * `ctx.tools.guard` reset at each `step`). Default: unlimited (Phase 1).
   */
  maxToolCallsPerTurn?: number;
  /**
   * Phase 0 TESTER handoff: after a turn quiesces, poll the worktree for the
   * structured test-results file and emit it as a `set('testResults')` mutation.
   * Undefined for roles that never produce test results (e.g. CODER).
   */
  readTestResults?: () => Promise<TestResults | undefined>;
  /**
   * Phase 0 CODER handoff: after a turn quiesces, poll the worktree for the
   * completion signal and emit it as a `mergeById('subtasks')` mutation.
   * Undefined for roles that never own a subtask.
   */
  readSubtaskStatus?: () => Promise<{ id: string; status: string } | undefined>;
  /**
   * Phase 2 handoff seam (task 2.5): after a turn quiesces, derive extra
   * mutations from the turn's final assistant text. This is the only output
   * channel of tool-less roles (PM is 纯推理 per §2) and of read-only roles
   * whose matrix grant has no fs.write (ARCHITECT/REVIEWER): the composition
   * root interprets the structured final message into State mutations, which
   * still flow through applyMutations (R1). Undefined for roles covered by
   * the file protocol (CODER/TESTER) or with no writes (COORDINATOR).
   */
  readTurnMutations?: (turn: { text: string | null }) => Mutation[] | Promise<Mutation[]>;
  /** D4 durable session namespace and optional deterministic lineage-child id. */
  sessionPersistence?: {
    root: string;
    cwd: string;
    projectId: string;
    taskId: string;
    resumeSessionId?: string;
  };
}

interface SafePointPayload {
  version: 1;
  projectId: string;
  taskId: string;
  role: string;
  sourceSessionId: string;
  boundary: number;
  cwd: string;
  agentPreset: string;
}

export interface HarnessSafePointIdentity {
  projectId: string;
  taskId: string;
  role: string;
  cwd: string;
}

const SAFE_POINT_PREFIX = 'agora-safe-point:v1:';

/** Adapter-internal routing metadata; callers must still pass the opaque ref back unchanged. */
export function inspectHarnessSafePoint(cursor: string): HarnessSafePointIdentity {
  const checkpoint = decodeSafePoint(cursor);
  return {
    projectId: checkpoint.projectId,
    taskId: checkpoint.taskId,
    role: checkpoint.role,
    cwd: checkpoint.cwd,
  };
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
  private readonly tools: readonly ToolDefinition[] | undefined;
  private readonly allowTools: readonly string[] | undefined;
  private readonly approval: HarnessExecutorOptions['approval'];
  private readonly maxToolCallsPerTurn: number | undefined;
  private readonly readTestResults: (() => Promise<TestResults | undefined>) | undefined;
  private readonly readSubtaskStatus:
    | (() => Promise<{ id: string; status: string } | undefined>)
    | undefined;
  private readonly readTurnMutations: HarnessExecutorOptions['readTurnMutations'];
  private readonly sessionPersistence: HarnessExecutorOptions['sessionPersistence'];
  private readonly pluginFibers: Fiber[] = [];
  private ready: Promise<void>;
  private readonly handles = new Map<string, AgentHandle>();
  private readonly restrictDisposers = new Map<string, () => void>();
  private readonly agentErrors = new Map<string, unknown>();
  private view: ProjectionView = { role: '', slices: {} };
  private pendingInbox: ProjectionView | null = null;
  private stepChain: Promise<unknown> = Promise.resolve();
  private activeSessionId: string | null = null;
  private toolCallsThisTurn = 0;

  constructor(
    private readonly spec: RoleSpec,
    options: HarnessExecutorOptions = {},
  ) {
    this.ctx = new Context();
    // Minimal plugin set; load order respects each plugin's `inject` deps.
    this.pluginFibers.push(this.ctx.plugin(AgentRegistry)); // ctx.agents
    this.pluginFibers.push(this.ctx.plugin(SessionStore)); // ctx.sessions
    if (options.sessionPersistence !== undefined) {
      this.pluginFibers.push(
        this.ctx.plugin(JsonlSessionPersistence, { root: options.sessionPersistence.root }),
      );
    }
    this.pluginFibers.push(this.ctx.plugin(LlmRuntime)); // ctx.llm
    this.pluginFibers.push(this.ctx.plugin(SystemPrompt, { persona: this.spec.systemPrompt })); // ctx.systemPrompt
    this.pluginFibers.push(this.ctx.plugin(ToolRuntime)); // ctx.tools (injects systemPrompt)
    this.pluginFibers.push(
      this.ctx.plugin({
        name: toolCallTimeoutPolicyName,
        inject: toolCallTimeoutPolicyInject,
        apply: applyToolCallTimeoutPolicy,
      }),
    ); // ctx.tools timeout policy (task 1.5, R7): arms ToolDefinition.timeoutMs → TOOL_TIMEOUT
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
    this.tools = options.tools;
    this.allowTools = options.allowTools;
    this.approval = options.approval;
    this.maxToolCallsPerTurn = options.maxToolCallsPerTurn;
    this.readTestResults = options.readTestResults;
    this.readSubtaskStatus = options.readSubtaskStatus;
    this.readTurnMutations = options.readTurnMutations;
    this.sessionPersistence = options.sessionPersistence;
    this.ready = this.awaitPlugins();
  }

  private async awaitPlugins(): Promise<void> {
    await Promise.all(this.pluginFibers);
    if (this.adapter !== undefined) {
      this.ctx.llm.registerAdapter([this.provider], this.adapter);
    }
    if (this.tools !== undefined) {
      for (const definition of this.tools) {
        this.ctx.tools.register(definition);
      }
    }
    // Task 1.5 governance: per-turn rate limit via a monotonic guard. The
    // counter is reset at each step() entry; a denial is final (guards cannot
    // be overruled by later listeners).
    if (this.maxToolCallsPerTurn !== undefined) {
      this.ctx.tools.guard(() => {
        this.toolCallsThisTurn += 1;
        if (this.toolCallsThisTurn > (this.maxToolCallsPerTurn as number)) {
          return `tool call budget exceeded (max ${this.maxToolCallsPerTurn} per turn)`;
        }
        return undefined;
      });
    }
    // Task 1.5 governance: pre-dispatch approval gate. Phase 1 defaults to
    // allow-all; Phase 8 plugs the humanGate decision into `approval`.
    this.ctx.on('tools/pre-execute', async (exec, next) => {
      if (this.approval === undefined) return next();
      const decision = await this.approval({ name: exec.name, arguments: exec.arguments });
      if (decision === undefined || decision.kind === 'allow') return next();
      return { kind: 'deny', reason: decision.reason };
    });
  }

  /** One worker turn = one `step()`; serialized so concurrent calls cannot cross-read turns. */
  async step(context: StepContext): Promise<StepResult> {
    const run = this.stepChain.then(() => this.doStep(context));
    this.stepChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async doStep(context: StepContext): Promise<StepResult> {
    await this.ready;
    this.toolCallsThisTurn = 0;
    // Injected view (injectInbox) wins over context.view on the next step.
    if (this.pendingInbox !== null) {
      this.view = this.pendingInbox;
      this.pendingInbox = null;
    } else {
      this.view = context.view;
    }
    this.activeSessionId = context.sessionId;
    const agent = await this.ensureAgent(context.sessionId);

    // Wake the self-driving loop with the projection slice as this turn's input.
    agent.followup(this.projectionMessage());
    await agent.whenIdle();

    const failure = this.agentErrors.get(context.sessionId);
    if (failure !== undefined) {
      this.agentErrors.delete(context.sessionId);
      throw new Error(`agent turn failed: ${failureMessage(failure)}`);
    }

    const turn = lastAssistantTurn(agent, context.sessionId);
    const parsed = turn === null ? null : parseChannelAction(turn.text, turn.msgId);
    const text = parsed?.text ?? turn?.text ?? null;
    const message =
      turn === null ? null : this.toAgoraMessage(turn.msgId, text as string, parsed?.channelAction);
    const mutations: Mutation[] = message === null ? [] : [appendMutation('messages', message)];
    if (this.readTestResults !== undefined) {
      const testResults = await this.readTestResults();
      if (testResults !== undefined) {
        mutations.push(setMutation('testResults', testResults));
      }
    }
    if (this.readSubtaskStatus !== undefined) {
      const subtask = await this.readSubtaskStatus();
      if (subtask !== undefined) {
        mutations.push(mergeByIdMutation('subtasks', subtask.id, { status: subtask.status }));
      }
    }
    if (this.readTurnMutations !== undefined) {
      mutations.push(...(await this.readTurnMutations({ text })));
    }
    return {
      kind: 'done',
      output:
        text === null
          ? {}
          : parsed?.channelAction === undefined
            ? { text }
            : { text, channelAction: parsed.channelAction },
      reachedSafeBoundary: true,
      mutations,
    };
  }

  /** D4 durability barrier followed by an opaque, scope-bound completed-turn reference. */
  async saveSafePoint(): Promise<string> {
    await this.ready;
    const persistence = this.requireSessionPersistence();
    const activeSessionId = this.activeSessionId;
    if (activeSessionId === null)
      throw new Error('cannot save a safe point without an active session');
    const session = this.ctx.sessions.get(SessionId(activeSessionId));
    if (session === undefined)
      throw new Error(`active session "${activeSessionId}" is unavailable`);
    const participated = await this.ctx.sessions.flush(session);
    if (!participated) throw new Error('session persistence listener did not participate in flush');
    const stored = await this.ctx.sessionPersistence.load(SessionId(activeSessionId));
    const boundary = lastCompletedTurnBoundary(stored.events);
    if (boundary === undefined) throw new Error('persisted session has no completed turn boundary');
    return encodeSafePoint({
      version: 1,
      projectId: persistence.projectId,
      taskId: persistence.taskId,
      role: this.spec.role,
      sourceSessionId: activeSessionId,
      boundary,
      cwd: persistence.cwd,
      agentPreset: this.agentPreset(),
    });
  }

  /** Load a durable source prefix and atomically create or resume its lineage child Agent. */
  async loadSafePoint(cursor: string): Promise<void> {
    await this.ready;
    const persistence = this.requireSessionPersistence();
    const resumeSessionId = persistence.resumeSessionId;
    if (resumeSessionId === undefined) {
      throw new Error('loadSafePoint requires a deterministic resumeSessionId');
    }
    const checkpoint = decodeSafePoint(cursor);
    assertCheckpointScope(checkpoint, persistence, this.spec.role, this.agentPreset());
    const source = await this.ctx.sessionPersistence.load(SessionId(checkpoint.sourceSessionId));
    if (source.meta.cwd !== checkpoint.cwd || source.meta.agentPreset !== checkpoint.agentPreset) {
      throw new Error('safe point source session metadata does not match the checkpoint');
    }
    const seed = source.events.slice(0, checkpoint.boundary + 1);
    if (
      seed.length !== checkpoint.boundary + 1 ||
      seed.some((event, index) => event.seq !== index) ||
      seed.at(-1)?.type !== 'turn/end'
    ) {
      throw new Error('safe point does not identify a contiguous completed-turn prefix');
    }

    const childId = SessionId(resumeSessionId);
    const existing = (await this.ctx.sessionPersistence.list()).find(
      (header) => header.id === childId,
    );
    const handle =
      existing === undefined
        ? await this.ctx.agents.create({
            sessionId: childId,
            seed,
            meta: {
              cwd: checkpoint.cwd,
              parentSession: SessionId(checkpoint.sourceSessionId),
              seedLength: seed.length,
              delegationDepth: 0,
              agentPreset: checkpoint.agentPreset,
            },
            agentOptions: { provider: this.provider, model: this.resolveModel() },
            setup: this.agentSetup(resumeSessionId),
          })
        : await this.resumeExistingChild(existing, checkpoint, seed.length, resumeSessionId);
    this.handles.set(resumeSessionId, handle);
    this.activeSessionId = resumeSessionId;
    const child = this.ctx.sessions.get(childId);
    if (child === undefined || !(await this.ctx.sessions.flush(child))) {
      throw new Error('lineage child session was not durably persisted');
    }
  }

  /** Store the projection for the next `step`; the next `agent/pre-step` re-projects from it. */
  injectInbox(view: ProjectionView): void {
    this.pendingInbox = view;
  }

  /** Release every agent loop and tear down all loaded plugins (reverse order). */
  async dispose(): Promise<void> {
    await this.ready;
    for (const handle of this.handles.values()) {
      await handle.dispose();
    }
    this.handles.clear();
    for (const disposer of this.restrictDisposers.values()) {
      disposer();
    }
    this.restrictDisposers.clear();
    this.activeSessionId = null;
    for (let i = this.pluginFibers.length - 1; i >= 0; i -= 1) {
      await this.pluginFibers[i]?.dispose();
    }
  }

  private async ensureAgent(sessionId: string): Promise<Agent> {
    const existing = this.handles.get(sessionId);
    if (existing !== undefined) return existing.agent;
    const handle = await this.ctx.agents.create({
      sessionId: SessionId(sessionId),
      ...(this.sessionPersistence === undefined
        ? {}
        : {
            meta: {
              cwd: this.sessionPersistence.cwd,
              delegationDepth: 0,
              agentPreset: this.agentPreset(),
            },
          }),
      agentOptions: { provider: this.provider, model: this.resolveModel() },
      setup: this.agentSetup(sessionId),
    });
    this.handles.set(sessionId, handle);
    return handle.agent;
  }

  private agentSetup(sessionId: string) {
    return (agentCtx: Context) => {
      // Decision D1: overwrite the messages fed to the LLM with the projection,
      // but PRESERVE the mid-turn tool exchange (tool-call/tool-result) from the
      // claimed inbox messages. Without this the model would never see its own
      // tool outcomes and could not iterate (write code → run tests → fix).
      agentCtx.on('agent/pre-step', async (payload) => ({
        kind: 'enter',
        messages: [this.projectionMessage(), ...toolExchangeOf(payload.messages)],
      }));
      // Model routing: fix the provider/model from RoleSpec or env.
      agentCtx.on('agent/request', async (_payload, next) => {
        const config = await next();
        return { ...config, provider: this.provider, model: this.resolveModel() };
      });
      // The self-driving loop swallows turn failures internally (kick() catch);
      // surface them so a broken turn is never mistaken for an empty success.
      agentCtx.on('agent/error', (payload) => {
        this.agentErrors.set(sessionId, payload.error);
      });
      // Task 1.5 scoping (Phase 1 toolFilter equivalent): an empty allow array
      // hides every global tool, which is the correct state for tool-less roles.
      if (this.allowTools !== undefined) {
        const disposer = agentCtx.tools.restrict({ allow: [...this.allowTools] });
        this.restrictDisposers.set(sessionId, disposer);
      }
    };
  }

  private async resumeExistingChild(
    existing: {
      id: string;
      cwd?: string;
      parentSession?: string;
      seedLength?: number;
      agentPreset?: string;
    },
    checkpoint: SafePointPayload,
    seedLength: number,
    resumeSessionId: string,
  ): Promise<AgentHandle> {
    if (
      existing.cwd !== checkpoint.cwd ||
      existing.parentSession !== checkpoint.sourceSessionId ||
      existing.seedLength !== seedLength ||
      existing.agentPreset !== checkpoint.agentPreset
    ) {
      throw new Error(`persisted child session "${resumeSessionId}" has conflicting lineage`);
    }
    return this.ctx.agents.resume({
      resumeSessionId: SessionId(resumeSessionId),
      agentOptions: { provider: this.provider, model: this.resolveModel() },
      setup: this.agentSetup(resumeSessionId),
    });
  }

  private requireSessionPersistence(): NonNullable<HarnessExecutorOptions['sessionPersistence']> {
    if (this.sessionPersistence === undefined) {
      throw new Error('Harness session persistence is required for D4 safe points');
    }
    return this.sessionPersistence;
  }

  private agentPreset(): string {
    return `agora-role:${this.spec.role}`;
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

  private toAgoraMessage(msgId: string, text: string, channelAction?: ParsedChannelAction) {
    return {
      msgId,
      channelId: 'main',
      fromRole: this.spec.role,
      type: 'chat' as const,
      payload: channelAction === undefined ? {} : { channelAction },
      display:
        text.length > 0 || channelAction === undefined ? text : channelActionDisplay(channelAction),
      ts: Date.now(),
    };
  }
}

function lastCompletedTurnBoundary(
  events: readonly { seq: number; type: string }[],
): number | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === 'turn/end') return event.seq;
  }
  return undefined;
}

function encodeSafePoint(payload: SafePointPayload): string {
  return `${SAFE_POINT_PREFIX}${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`;
}

function decodeSafePoint(cursor: string): SafePointPayload {
  if (!cursor.startsWith(SAFE_POINT_PREFIX)) throw new Error('invalid safe point reference prefix');
  let value: unknown;
  try {
    value = JSON.parse(
      Buffer.from(cursor.slice(SAFE_POINT_PREFIX.length), 'base64url').toString('utf8'),
    );
  } catch (error) {
    throw new Error('invalid safe point reference encoding', { cause: error });
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('invalid safe point reference payload');
  }
  const record = value as Record<string, unknown>;
  const expected = [
    'agentPreset',
    'boundary',
    'cwd',
    'projectId',
    'role',
    'sourceSessionId',
    'taskId',
    'version',
  ];
  if (Object.keys(record).sort().join('\0') !== expected.sort().join('\0')) {
    throw new Error('invalid safe point reference fields');
  }
  if (
    record.version !== 1 ||
    typeof record.projectId !== 'string' ||
    record.projectId.length === 0 ||
    typeof record.taskId !== 'string' ||
    record.taskId.length === 0 ||
    typeof record.role !== 'string' ||
    record.role.length === 0 ||
    typeof record.sourceSessionId !== 'string' ||
    record.sourceSessionId.length === 0 ||
    typeof record.boundary !== 'number' ||
    !Number.isInteger(record.boundary) ||
    record.boundary < 0 ||
    typeof record.cwd !== 'string' ||
    record.cwd.length === 0 ||
    typeof record.agentPreset !== 'string' ||
    record.agentPreset.length === 0
  ) {
    throw new Error('invalid safe point reference payload');
  }
  return record as unknown as SafePointPayload;
}

function assertCheckpointScope(
  checkpoint: SafePointPayload,
  persistence: NonNullable<HarnessExecutorOptions['sessionPersistence']>,
  role: string,
  agentPreset: string,
): void {
  if (
    checkpoint.projectId !== persistence.projectId ||
    checkpoint.taskId !== persistence.taskId ||
    checkpoint.role !== role ||
    checkpoint.cwd !== persistence.cwd ||
    checkpoint.agentPreset !== agentPreset
  ) {
    throw new Error('safe point scope does not match the executor composition');
  }
}

/** Keep only mid-turn tool messages (call/result) from the claimed inbox messages. */
function toolExchangeOf(messages: readonly UserMessage[]): UserMessage[] {
  return messages.filter((message) =>
    message.content.some((block) => block.type === 'tool-call' || block.type === 'tool-result'),
  );
}

function failureMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

interface AssistantTurn {
  text: string;
  msgId: string;
}

type ParsedChannelAction =
  | {
      kind: 'open_sub_channel';
      actionId: string;
      threadId?: string;
      requestedRoles: string[];
      topic: string;
    }
  | { kind: 'close_sub_channel'; actionId: string; channelId: string };

interface ParsedAssistantText {
  text: string;
  channelAction?: ParsedChannelAction;
}

const CHANNEL_ACTION_OPEN = '<agora-channel-action>';
const CHANNEL_ACTION_CLOSE = '</agora-channel-action>';
const CHANNEL_ACTION_PATTERN = /<agora-channel-action>([\s\S]*?)<\/agora-channel-action>/g;

function parseChannelAction(text: string, actionId: string): ParsedAssistantText {
  if (!text.includes(CHANNEL_ACTION_OPEN) && !text.includes(CHANNEL_ACTION_CLOSE)) return { text };

  const trimmed = text.trimEnd();
  const matches = [...trimmed.matchAll(CHANNEL_ACTION_PATTERN)];
  const match = matches[0];
  if (
    matches.length !== 1 ||
    match === undefined ||
    match.index === undefined ||
    match.index + match[0].length !== trimmed.length ||
    occurrences(trimmed, CHANNEL_ACTION_OPEN) !== 1 ||
    occurrences(trimmed, CHANNEL_ACTION_CLOSE) !== 1
  ) {
    throw new Error('invalid agora channel action: expected one final control block');
  }

  let value: unknown;
  try {
    value = JSON.parse(match[1] ?? '');
  } catch (error) {
    throw new Error('invalid agora channel action: malformed JSON', { cause: error });
  }
  const channelAction = validateChannelAction(value, actionId);
  return { text: trimmed.slice(0, match.index).trimEnd(), channelAction };
}

function validateChannelAction(value: unknown, actionId: string): ParsedChannelAction {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('invalid agora channel action: payload must be an object');
  }
  const record = value as Record<string, unknown>;
  if (record.kind === 'open_sub_channel') {
    assertExactKeys(
      record,
      record.threadId === undefined
        ? ['kind', 'requestedRoles', 'topic']
        : ['kind', 'requestedRoles', 'threadId', 'topic'],
    );
    if (
      !Array.isArray(record.requestedRoles) ||
      !record.requestedRoles.every((role) => typeof role === 'string' && role.length > 0)
    ) {
      throw new Error('invalid agora channel action: requestedRoles must contain role strings');
    }
    if (typeof record.topic !== 'string' || record.topic.length === 0) {
      throw new Error('invalid agora channel action: topic must be a non-empty string');
    }
    if (
      record.threadId !== undefined &&
      (typeof record.threadId !== 'string' || !SAFE_CHANNEL_SEGMENT.test(record.threadId))
    ) {
      throw new Error('invalid agora channel action: threadId must be a safe non-empty segment');
    }
    return {
      kind: 'open_sub_channel',
      actionId,
      ...(record.threadId === undefined ? {} : { threadId: record.threadId }),
      requestedRoles: [...record.requestedRoles],
      topic: record.topic,
    };
  }
  if (record.kind === 'close_sub_channel') {
    assertExactKeys(record, ['kind', 'channelId']);
    if (typeof record.channelId !== 'string' || record.channelId.length === 0) {
      throw new Error('invalid agora channel action: channelId must be a non-empty string');
    }
    return { kind: 'close_sub_channel', actionId, channelId: record.channelId };
  }
  throw new Error('invalid agora channel action: unknown kind');
}

const SAFE_CHANNEL_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function channelActionDisplay(action: ParsedChannelAction): string {
  return action.kind === 'open_sub_channel'
    ? `Requested opening a sub-channel: ${action.topic}.`
    : `Requested closing sub-channel ${action.channelId}.`;
}

function assertExactKeys(record: Record<string, unknown>, expected: readonly string[]): void {
  const keys = Object.keys(record).sort();
  const canonicalExpected = [...expected].sort();
  if (
    keys.length !== canonicalExpected.length ||
    keys.some((key, index) => key !== canonicalExpected[index])
  ) {
    throw new Error('invalid agora channel action: unexpected fields');
  }
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/** Extract the last assistant text block and stable event identity from the durable session log. */
function lastAssistantTurn(agent: Agent, sessionId: string): AssistantTurn | null {
  for (let i = agent.session.events.length - 1; i >= 0; i -= 1) {
    const event = agent.session.events[i];
    if (event?.type === 'assistant/message') {
      const message = (event.data as { message?: { content: unknown[] } }).message;
      if (message === undefined) continue;
      for (let j = message.content.length - 1; j >= 0; j -= 1) {
        const block = message.content[j] as { type?: string; text?: string } | undefined;
        if (block?.type === 'text' && typeof block.text === 'string' && block.text !== '') {
          const digest = createHash('sha256')
            .update(`${sessionId}:${event.seq}`)
            .digest('hex')
            .slice(0, 24);
          return { text: block.text, msgId: `assistant-${digest}` };
        }
      }
    }
  }
  return null;
}
