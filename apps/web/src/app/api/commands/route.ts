export const runtime = 'nodejs';

export async function POST(_request: Request): Promise<Response> {
  return Response.json(
    {
      error: 'POST /api/commands is retired; send Leader messages through POST /api/messages',
    },
    { status: 410 },
  );
}
