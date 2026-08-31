import { channelStream } from '../../../server/channel-stream';
import { jsonError, readJsonObject, requiredString } from '../../../server/http';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  const body = await readJsonObject(request);
  const channelId = requiredString(body?.channelId);
  const fromRole = requiredString(body?.fromRole);
  const hasPayload = body ? Object.hasOwn(body, 'payload') : false;
  const payload = body?.payload;

  if (!channelId || !fromRole || !hasPayload) {
    return jsonError('channelId, fromRole, and payload are required');
  }

  const delivered = channelStream.publish(channelId, {
    type: 'message',
    data: { channelId, fromRole, payload },
  });

  return Response.json({ accepted: true, delivered }, { status: 202 });
}
