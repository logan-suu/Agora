import { channelStream } from '../../../server/channel-stream';
import { jsonError, readJsonObject, requiredString } from '../../../server/http';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  const body = await readJsonObject(request);
  const projectId = requiredString(body?.projectId);
  const taskId = requiredString(body?.taskId);
  const channelId = requiredString(body?.channelId);
  const command = requiredString(body?.command);

  if (!projectId || !taskId || !channelId || !command) {
    return jsonError('projectId, taskId, channelId, and command are required');
  }

  const delivered = channelStream.publish(
    { projectId, taskId, channelId },
    {
      type: 'command',
      data: { projectId, taskId, channelId, command },
    },
  );

  return Response.json({ accepted: true, delivered }, { status: 202 });
}
