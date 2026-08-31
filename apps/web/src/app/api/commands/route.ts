import { channelStream } from '../../../server/channel-stream';
import { jsonError, readJsonObject, requiredString } from '../../../server/http';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  const body = await readJsonObject(request);
  const channelId = requiredString(body?.channelId);
  const command = requiredString(body?.command);

  if (!channelId || !command) {
    return jsonError('channelId and command are required');
  }

  const delivered = channelStream.publish(channelId, {
    type: 'command',
    data: { channelId, command },
  });

  return Response.json({ accepted: true, delivered }, { status: 202 });
}
