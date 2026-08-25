import { describe, expect, it } from 'vitest';
import { AGORA_APP_NAME } from '../src/index';

describe('AGORA_APP_NAME', () => {
  it('exposes the app name when the shared module is imported', () => {
    expect(AGORA_APP_NAME).toBe('agora');
  });
});
