import { firstRunService } from '../../../../server/first-run';
import { firstRunScope } from '../../../../server/first-run-policy';
import { readJsonObject } from '../../../../server/http';
import { RequirementInputError } from '../../../../server/message-runtime';
import { ModelSettingsError } from '../../../../server/model-settings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const failure = (e: unknown) =>
  Response.json(
    {
      error:
        e instanceof ModelSettingsError ||
        e instanceof RequirementInputError ||
        (e instanceof Error && /^[a-z_]{1,64}$/.test(e.message))
          ? e.message
          : 'first_run_failed',
    },
    { status: 409 },
  );
export async function GET() {
  try {
    return Response.json(
      { projects: await (await firstRunService()).list() },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (e) {
    return failure(e);
  }
}
export async function POST(request: Request) {
  try {
    if (!request.headers.get('content-type')?.startsWith('application/json'))
      throw Error('invalid_entry_request');
    const body = await readJsonObject(request);
    if (!body || typeof body.action !== 'string') throw Error('invalid_entry_request');
    const service = await firstRunService();
    const fields: Record<string, string[]> = {
      scope: ['action', 'operationId'],
      selection: ['action', 'operationId', 'selectionRef'],
      prepare: ['action', 'operationId', 'selectionRef', 'goal'],
      inspect: ['action', 'projectId'],
      start: ['action', 'projectId', 'requestId', 'inspectionRef'],
    };
    const allowed = fields[body.action];
    if (
      !allowed ||
      Object.keys(body).length !== allowed.length ||
      allowed.some((k) => typeof body[k] !== 'string')
    )
      throw Error('invalid_entry_request');
    switch (body.action) {
      case 'scope':
        return Response.json(firstRunScope(body.operationId as string));
      case 'selection':
        return Response.json(
          await service.rememberSelection(body.operationId as string, body.selectionRef as string),
        );
      case 'prepare':
        return Response.json(
          await service.prepare(
            body.operationId as string,
            body.selectionRef as string,
            body.goal as string,
          ),
        );
      case 'inspect':
        return Response.json(await service.inspect(body.projectId as string));
      case 'start':
        return Response.json(
          await service.start(
            body.projectId as string,
            body.requestId as string,
            body.inspectionRef as string,
          ),
          { status: 202 },
        );
    }
    throw Error('invalid_entry_request');
  } catch (e) {
    return failure(e);
  }
}
