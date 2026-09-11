import type { GenerateOptions } from '@deepseek-ai/dsh-llm';

/** Each session may recover from one failed generation step. A batch of tool
 * results is one opportunity to react; infrastructure faults stop immediately.
 */
export class FlowToolPolicy {
  private readonly observed = new Set<string>();
  private readonly failedBatches = new Map<string, Set<string>>();
  private readonly batches = new Map<string, string>();
  private readonly tools = new Map<string, string>();
  inspect(options: GenerateOptions): void {
    const session = options.sessionId;
    if (!session) throw new Error('tool recovery requires a stable session identity');
    const identity = (id: string) => JSON.stringify([session, id]);
    for (const message of options.messages) {
      const calls = message.content.filter((block) => block.type === 'tool-call');
      const batch = JSON.stringify(calls.map((call) => call.id).sort());
      for (const call of calls) {
        this.tools.set(identity(call.id), call.name);
        // Never regroup an already observed call when history is reprojected.
        if (!this.batches.has(identity(call.id))) this.batches.set(identity(call.id), batch);
      }
    }
    for (const message of options.messages)
      for (const block of message.content) {
        if (block.type !== 'tool-result') continue;
        const text = block.content
          .filter((c) => c.type === 'text')
          .map((c) => c.text)
          .join('\n');
        let commandUnavailable = false;
        if (!block.isError && this.tools.get(identity(block.toolCallId)) === 'sandbox_run') {
          // The sandbox envelope can succeed while the requested executable is unavailable.
          // Ordinary business test failures (exit 1) remain model-correctable outcomes.
          try {
            const result = JSON.parse(text);
            commandUnavailable = result?.exitCode === 126 || result?.exitCode === 127;
          } catch {
            // Text results and file contents are not sandbox execution envelopes.
          }
        }
        if (!block.isError && !commandUnavailable) continue;
        const unknown = /^Error: unknown tool "([^"]*)"$/.exec(text);
        if (unknown && !unknown[1]) throw new Error('empty tool identity; stop diagnostic');
        if (block.isError && /UNSUPPORTED_SCHEMA|EACCES|ECONNREFUSED|unauthorized/i.test(text))
          throw new Error('systemic tool failure; stop diagnostic');
        const call = identity(block.toolCallId);
        if (!this.observed.has(call)) {
          this.observed.add(call);
          const failed = this.failedBatches.get(session) ?? new Set<string>();
          failed.add(this.batches.get(call) ?? JSON.stringify([block.toolCallId]));
          this.failedBatches.set(session, failed);
        }
        if ((this.failedBatches.get(session)?.size ?? 0) > 1)
          throw new Error('repeated tool failure; stop diagnostic');
      }
  }
}
