import type { runTool } from './local-process.mjs';

export const installGuide: string;
export const platformError: string;
export function checkDependencies(
  repo: string,
  options?: { platform?: string; nodeVersion?: string; run?: typeof runTool },
): Promise<void>;
