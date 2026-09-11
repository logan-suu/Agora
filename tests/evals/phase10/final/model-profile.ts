export const OFFICIAL_MODELS = ['deepseek-v4-flash', 'deepseek-v4-pro'] as const;

export const OFFICIAL_CONFIG = {
  provider: 'deepseek-official',
  apiKeyEnv: 'DEEPSEEK_API_KEY',
  accountingMetric: 'estimated-api-cost-usd',
  endpoint: 'https://api.deepseek.com',
  maxTokens: 32768,
  contextLimit: 65536,
  contextMetric: 'harness-heuristic-tokens',
  temperature: 0.2,
  thinking: 'enabled' as const,
  reasoningEffort: 'high' as const,
  maxCalls: 120,
  maxTools: 240,
  maxDurationMs: 1_200_000,
  pricingSource: 'https://api-docs.deepseek.com/quick_start/pricing/',
  pricingChecked: '2026-09-09',
  peakRates: {
    'deepseek-v4-flash': { input: 0.44, cacheRead: 0.014, output: 1.32 },
    'deepseek-v4-pro': { input: 1.32, cacheRead: 0.044, output: 3.96 },
  },
};

/** Selected connection for future evaluations; historical groups retain their frozen configuration. */
export const CONFIG = {
  ...OFFICIAL_CONFIG,
  provider: 'opencode-go',
  endpoint: 'https://opencode.ai/zen/go/v1',
  apiKeyEnv: 'OPENCODE_API_KEY',
  credentialSource: 'env-or-opencode-go-auth',
  budgetFile: 'phase10-opencode-go-quota-budget.json',
  accountingMetric: 'subscription-quota-equivalent-usd',
  modelRequestsEnabled: false,
  pricingSource: 'https://opencode.ai/docs/go/#usage-limits',
  pricingChecked: '2026-09-10',
  peakRates: {
    'deepseek-v4-flash': { input: 0.3, cacheRead: 0.006, output: 1.2 },
    'deepseek-flash': { input: 0.3, cacheRead: 0.006, output: 1.2 },
  },
};
