import { messageRuntime } from './message-runtime';
import { ModelSettingsService } from './model-settings';
import { createWebTaskCompositionFactory } from './task-composition';
import { TaskOrchestrationRuntime } from './task-orchestration-runtime';

export const taskRuntime = new TaskOrchestrationRuntime(
  messageRuntime,
  createWebTaskCompositionFactory({
    dataRoot: messageRuntime.root,
    modelSettings: new ModelSettingsService(messageRuntime),
  }),
);
