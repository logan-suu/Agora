import { join } from 'node:path';
import { GlobalScheduler } from '@agora/core-orchestration';
import { HarnessRequirementInterpreter } from '@agora/runtime-executor';
import { messageRuntime } from './message-runtime';
import { ModelSettingsService } from './model-settings';
import { createWebTaskCompositionFactory } from './task-composition';
import { TaskOrchestrationRuntime } from './task-orchestration-runtime';

const scheduler = new GlobalScheduler();
const modelSettings = new ModelSettingsService(messageRuntime);
messageRuntime.bindRequirementInterpreter({
  async interpret(input) {
    const binding = await modelSettings.freeze(input, input.goal);
    const routes = await modelSettings.executorRoutes(binding);
    const route = routes.get('COORDINATOR');
    if (!route) throw new Error('Coordinator model is unavailable');
    const lease = await scheduler.acquire(
      input.projectId,
      input.taskId,
      `leader-input:${input.sourceMsgId}`,
    );
    try {
      const root = join(messageRuntime.root, 'projects', input.projectId, 'tasks', input.taskId);
      return await new HarnessRequirementInterpreter(route.model, {
        ...(route.compatible ? { compatible: route.compatible } : { deepseek: true }),
        sessionPersistence: {
          root: join(root, 'harness-sessions'),
          cwd: root,
          projectId: input.projectId,
          taskId: input.taskId,
        },
      }).interpret(input);
    } finally {
      scheduler.release(lease);
    }
  },
});

export const taskRuntime = new TaskOrchestrationRuntime(
  messageRuntime,
  createWebTaskCompositionFactory({
    dataRoot: messageRuntime.root,
    modelSettings,
    scheduler,
  }),
);
