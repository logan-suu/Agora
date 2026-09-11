import { createRequire } from 'node:module';
import type { GenerateOptions, Message } from '@deepseek-ai/dsh-llm';

// Reuse the executor's already locked dependency; add no benchmark tokenizer dependency.
const runtimeRequire = createRequire(
  new URL('../../../../packages/runtime/executor/package.json', import.meta.url),
);
const { TokenMeter } = (await import(runtimeRequire.resolve('@deepseek-ai/dsh-token-meter'))) as {
  TokenMeter: { prototype: { estimateMessage(message: Message): number } };
};
// The locked public estimator is stateless (it only reads message.content).
const estimateMessage = (message: Message) => TokenMeter.prototype.estimateMessage(message);
export function estimateInputTokens(options: GenerateOptions): number {
  const text = (value: string) =>
    estimateMessage({ content: [{ type: 'text', text: value }] } as Message) - 4;
  return (
    options.messages.reduce((sum, message) => sum + estimateMessage(message), 0) +
    (options.system === undefined ? 0 : text(options.system)) +
    (options.tools?.length ? text(JSON.stringify(options.tools)) : 0)
  );
}
export function inputByteUpperBound(options: GenerateOptions): number {
  return (
    Buffer.byteLength(
      JSON.stringify({ system: options.system, messages: options.messages, tools: options.tools }),
    ) +
    1024 * (options.messages.length + 1)
  );
}
