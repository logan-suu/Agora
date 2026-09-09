import { messageRuntime } from '../../../server/message-runtime';
import { ModelSettingsService, modelSettingsHandlers } from '../../../server/model-settings';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const { GET, POST } = modelSettingsHandlers(new ModelSettingsService(messageRuntime));
