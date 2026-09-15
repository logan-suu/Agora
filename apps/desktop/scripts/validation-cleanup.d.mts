import type { ChildProcess } from 'node:child_process';
export function cleanupChild(child: ChildProcess | undefined, timeout?: number): Promise<boolean>;
