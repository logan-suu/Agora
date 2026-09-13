import { expect, it } from 'vitest';
import { knownModelContextWindow, knownModelMaxOutputTokens } from '../src/lib/model-capacity';

it('uses verified DeepSeek capacity only for the matching provider endpoint and model', () => {
  for (const baseURL of [
    'https://api.deepseek.com',
    'https://api.deepseek.com/v1/',
    'https://opencode.ai/zen/go/v1',
  ]) {
    for (const model of ['deepseek-v4-flash', 'deepseek-v4-pro']) {
      expect(knownModelContextWindow(baseURL, model)).toBe(1000000);
      expect(knownModelMaxOutputTokens(baseURL, model)).toBe(384000);
    }
  }
  for (const baseURL of [
    'https://proxy.example/v1',
    'https://api.deepseek.com/other',
    'https://opencode.ai/zen/v1',
    'http://api.deepseek.com',
    'https://api.deepseek.com?x=1',
    'https://user@api.deepseek.com',
    'https://api.deepseek.com/#x',
    'invalid',
  ]) {
    expect(knownModelContextWindow(baseURL, 'deepseek-v4-flash')).toBeUndefined();
    expect(knownModelMaxOutputTokens(baseURL, 'deepseek-v4-flash')).toBeUndefined();
  }
  expect(knownModelContextWindow('https://api.deepseek.com', 'unknown')).toBeUndefined();
  expect(knownModelMaxOutputTokens('https://api.deepseek.com', 'unknown')).toBeUndefined();
});
