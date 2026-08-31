export function requiredString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

export async function readJsonObject(
  request: Request,
): Promise<Record<string, unknown> | undefined> {
  try {
    const value: unknown = await request.json();
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return undefined;
    }
    return value as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export function jsonError(error: string, status = 400): Response {
  return Response.json({ error }, { status });
}
