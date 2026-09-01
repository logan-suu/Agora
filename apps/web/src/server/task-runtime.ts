import { messageRuntime } from './message-runtime';
import { createWebTaskCompositionFactory } from './task-composition';
import { TaskOrchestrationRuntime } from './task-orchestration-runtime';

export const taskRuntime = new TaskOrchestrationRuntime(
  messageRuntime,
  createWebTaskCompositionFactory(),
);
