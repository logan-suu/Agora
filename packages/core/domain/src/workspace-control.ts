/** Parse data only. Authority requires the canonical Leader transport, current
 * proposal/selection and trusted registry; a valid command is never a capability. */
type Common = { projectId: string; taskId: string; actionId: string; expectedRevision: number };
export type WorkspaceControlIntent = { kind: 'workspace_control' } & Common &
  (
    | { verb: 'grant'; selectionRef: string; policyProposalId: string; inputHash: string }
    | { verb: 'revoke'; grantId: string }
    | { verb: 'takeover'; workspaceId: string; paths: string[] }
    | { verb: 'return'; takeoverReceiptId: string }
    | { verb: 'apply'; deliveryProposalId: string; inputHash: string }
    | { verb: 'undo'; fileApplyReceiptId: string; inputHash: string }
  );
const common = ['projectId', 'taskId', 'actionId', 'expectedRevision'];
const fields = {
  grant: ['selectionRef', 'policyProposalId', 'inputHash'],
  revoke: ['grantId'],
  takeover: ['workspaceId', 'paths'],
  return: ['takeoverReceiptId'],
  apply: ['deliveryProposalId', 'inputHash'],
  undo: ['fileApplyReceiptId', 'inputHash'],
} as const;
function reject(): never {
  throw new Error('invalid_workspace_control');
}
const id = (v: unknown) => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
const hash = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
function path(v: unknown): v is string {
  if (typeof v !== 'string' || !v || v.length > 4096) return false;
  let bytes = 0;
  for (const c of v) {
    const n = c.codePointAt(0) ?? 0;
    if (n < 32 || n === 127 || (n >= 0xd800 && n <= 0xdfff)) return false;
    bytes += n < 0x80 ? 1 : n < 0x800 ? 2 : n < 0x10000 ? 3 : 4;
  }
  return (
    bytes <= 4096 &&
    v
      .split('/')
      .every(
        (part) =>
          part !== '' &&
          part !== '.' &&
          part !== '..' &&
          new TextEncoder().encode(part).length <= 255,
      )
  );
}
export function parseWorkspaceControl(display: string): WorkspaceControlIntent | undefined {
  if (!/^\/workspace(?:\s|$)/.test(display)) return undefined;
  if (display.length > 65536) reject();
  const match = /^\/workspace (grant|revoke|takeover|return|apply|undo) ([\s\S]+)$/.exec(display);
  if (!match) reject();
  const verb = match[1] as keyof typeof fields;
  const body = match[2] as string;
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    reject();
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject();
  // Tokenize strings before punctuation so escaped quotes in values cannot be keys.
  // JSON.parse already validated syntax; the flat command schema forbids nested objects.
  const tokens = body.match(/"(?:\\.|[^"\\])*"|[{}[\]:,]|[^\s{}[\]:,]+/g) ?? [];
  const seen = new Set<string>();
  for (let i = 0; i < tokens.length - 1; i++)
    if (tokens[i + 1] === ':') {
      let key: unknown;
      try {
        key = JSON.parse(tokens[i] as string);
      } catch {
        reject();
      }
      if (typeof key !== 'string' || seen.has(key)) reject();
      seen.add(key);
    }
  const record = value as Record<string, unknown>,
    keys = [...common, ...fields[verb]];
  if (
    Object.keys(record).length !== keys.length ||
    !keys.every((k) => Object.hasOwn(record, k)) ||
    !['projectId', 'taskId', 'actionId'].every((k) => id(record[k])) ||
    typeof record.expectedRevision !== 'number' ||
    !Number.isSafeInteger(record.expectedRevision) ||
    record.expectedRevision < 0
  )
    reject();
  for (const field of fields[verb]) {
    const v = record[field];
    if (field === 'inputHash') {
      if (!hash(v)) reject();
    } else if (field === 'paths') {
      if (
        !Array.isArray(v) ||
        !v.length ||
        v.length > 256 ||
        !v.every(path) ||
        new Set(v).size !== v.length
      )
        reject();
    } else if (!id(v)) reject();
  }
  return { kind: 'workspace_control', verb, ...record } as WorkspaceControlIntent;
}
