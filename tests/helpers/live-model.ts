import { randomUUID } from 'node:crypto';
import type { HarnessExecutorOptions } from '@agora/runtime-executor';
import type { GenerateOptions } from '@deepseek-ai/dsh-llm';
import {
  DeepSeekAdapter,
  type DeepSeekAdapterOptions,
  resolveAdapterOptions,
} from '@deepseek-ai/dsh-llm-deepseek';
import { normalizeGoToolStream } from '../evals/phase10/final/go-tool-stream';
import { resolveOpenCodeGoApiKey } from '../evals/phase10/final/opencode-go';

/** Reuse the verified Go normalization on both native adapter entry points. */
class GoRegressionAdapter extends DeepSeekAdapter {
  override async *stream(options: GenerateOptions) {
    yield* normalizeGoToolStream(super.stream(options));
  }
  override async prepareCall(...args: Parameters<DeepSeekAdapter['prepareCall']>) {
    const call = await super.prepareCall(...args);
    return {
      ...call,
      stream: (options: GenerateOptions) => normalizeGoToolStream(call.stream(options)),
    };
  }
}

/** Temporary Leader-selected regression route; product and frozen eval bindings stay unchanged. */
export async function resolveLiveTestModel(
  options: { env?: Readonly<Record<string, string | undefined>>; authPath?: string } = {},
): Promise<{
  model: string;
  options: Pick<HarnessExecutorOptions, 'adapter' | 'provider'>;
}> {
  const env = options.env ?? process.env;
  if (env.AGORA_TEST_PROVIDER !== undefined && env.AGORA_TEST_PROVIDER !== 'opencode-go')
    throw new Error('live regressions currently require OpenCode Go V4 Flash');
  if (env.AGORA_EVAL_BUDGET_FILE !== undefined)
    throw new Error('official regression budget cannot account for OpenCode Go requests');
  const credentials = { env, ...(options.authPath ? { authPath: options.authPath } : {}) };
  // Missing or invalid Go credentials must fail, even when an official key is available.
  await resolveOpenCodeGoApiKey(credentials);
  const connection = resolveAdapterOptions({ baseURL: 'https://opencode.ai/zen/go/v1' });
  const userId = randomUUID() as ReturnType<DeepSeekAdapterOptions['resolveUserId']>;
  return {
    model: 'deepseek-v4-flash',
    options: {
      provider: 'opencode-go',
      adapter: new GoRegressionAdapter({
        options: () => connection,
        resolveApiKey: () => resolveOpenCodeGoApiKey(credentials),
        resolveUserId: () => userId,
      }),
    },
  };
}
