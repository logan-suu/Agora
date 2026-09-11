import type { GenerateOptions } from '@deepseek-ai/dsh-llm';

/** Read the actual D1 system section; missing or duplicate sections fail the fixture. */
export function projectedInputText(options: Pick<GenerateOptions, 'system'>): string {
  const matches = [
    ...(options.system ?? '').matchAll(/\[agora-projection\]\n([^\n]+)\n\[\/agora-projection\]/g),
  ];
  if (matches.length !== 1 || !matches[0]?.[1])
    throw new Error('Expected exactly one current Agora system projection');
  return matches[0][1];
}
