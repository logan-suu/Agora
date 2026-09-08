import type { TraceSnapshotView } from './chat-model';

export function traceLanes(trace: TraceSnapshotView, now: number) {
  type Session = TraceSnapshotView['sessions'][number];
  const sessions = new Map(trace.sessions.map((session) => [session.sessionId, session]));
  const lanes = new Map<
    string,
    { rootSessionId: string; role: string; parentOmitted: boolean; sessions: Session[] }
  >();
  const starts: number[] = [];
  const ends: number[] = [];
  let running = false;
  for (const session of trace.sessions) {
    let root = session;
    let rootId = session.sessionId;
    const visited = new Set<string>();
    while (root.parentSessionId !== undefined) {
      if (visited.has(root.sessionId)) throw new Error('trace lineage cycle');
      visited.add(root.sessionId);
      rootId = root.parentSessionId;
      const parent = sessions.get(rootId);
      if (parent === undefined) break;
      root = parent;
    }
    const lane = lanes.get(rootId) ?? {
      rootSessionId: rootId,
      role: root.role,
      parentOmitted: !sessions.has(rootId),
      sessions: [],
    };
    lane.sessions.push(session);
    lanes.set(rootId, lane);
    for (const turn of session.turns) {
      starts.push(turn.startedAt);
      ends.push(turn.endedAt ?? Math.max(now, turn.startedAt));
      if (turn.endedAt === undefined) running = true;
    }
  }
  const start = starts.length === 0 ? 0 : Math.min(...starts);
  const end = ends.length === 0 ? start + 1 : Math.max(start + 1, ...ends);
  return {
    start,
    end,
    running,
    lanes: [...lanes.values()].map((lane) => ({
      ...lane,
      sessions: [...lane.sessions].sort(
        (a, b) => a.createdAt - b.createdAt || a.sessionId.localeCompare(b.sessionId),
      ),
    })),
  };
}
