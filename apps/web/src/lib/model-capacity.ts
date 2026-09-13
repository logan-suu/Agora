/** Verified provider capacities; see technical selection §4.1 for dated sources. */
export function knownModelContextWindow(baseURL: string, model: string): number | undefined {
  if (!['deepseek-v4-flash', 'deepseek-v4-pro'].includes(model.trim())) return undefined;
  let url: URL;
  try {
    url = new URL(baseURL.trim());
  } catch {
    return undefined;
  }
  if (url.username || url.password || url.search || url.hash) return undefined;
  const path = url.pathname.replace(/\/$/, '');
  if (
    (url.origin === 'https://api.deepseek.com' && ['', '/v1'].includes(path)) ||
    (url.origin === 'https://opencode.ai' && path === '/zen/go/v1')
  )
    return 1000000;
  return undefined;
}

export function knownModelMaxOutputTokens(baseURL: string, model: string): number | undefined {
  return knownModelContextWindow(baseURL, model) === undefined ? undefined : 384000;
}
