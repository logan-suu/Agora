import * as React from 'react';
import { parseLeaderIntent } from '../lib/intent';
import { MessageMarkdown } from './message-markdown';

type RecordValue = Record<string, unknown>;
type Requirement = { id: string; story: string; acceptance: string[]; nonGoals: string[] };
type Verdict = RecordValue & { verdict: 'approved' | 'changes_requested'; summary: string };
type Delivery =
  | { kind: 'requirement-update'; entry: Requirement }
  | { kind: 'requirements'; entries: Requirement[] }
  | { kind: 'architecture'; architecture: RecordValue; conventions: RecordValue }
  | { kind: 'review'; verdict: Verdict; comments: RecordValue[] };

const labels: Record<string, string> = {
  executionPlan: 'Execution plan',
  dependsOn: 'Dependencies',
  requirementIds: 'Requirements',
  subtaskIds: 'Related tasks',
  issueScope: 'Change scope',
  nonGoals: 'Out of scope',
};
const safeId = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const record = (value: unknown): value is RecordValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

function bounded(value: unknown): boolean {
  const pending = [{ value, depth: 0 }];
  let count = 0;
  while (pending.length > 0) {
    const item = pending.pop();
    if (!item || ++count > 2000 || item.depth > 12) return false;
    if (item.value !== null && typeof item.value === 'object') {
      const children = Object.values(item.value);
      if (children.length + pending.length + count > 2000) return false;
      pending.push(...children.map((child) => ({ value: child, depth: item.depth + 1 })));
    }
  }
  return true;
}

/** Interpret only known display formats; this never reads agent payload or changes task facts. */
function deliveryFromDisplay(role: string, display: string): Delivery | undefined {
  if (role === 'leader' && display.length <= 100_000) {
    const intent = parseLeaderIntent(display);
    if (intent.kind === 'requirement_change')
      return {
        kind: 'requirement-update',
        entry: { id: intent.requirementId, ...intent.requirement },
      };
    return;
  }
  if (!['PM', 'ARCHITECT', 'REVIEWER'].includes(role) || display.length > 100_000) return;
  const text = display.trim();
  const fenced = /^```json[ \t]*\r?\n([\s\S]*?)```$/.exec(text);
  let value: unknown;
  try {
    value = JSON.parse(fenced?.[1] ?? text);
  } catch {
    return;
  }
  if (!bounded(value)) return;
  if (
    role === 'PM' &&
    Array.isArray(value) &&
    value.every(
      (item) =>
        record(item) &&
        typeof item.id === 'string' &&
        item.id.length > 0 &&
        typeof item.story === 'string' &&
        strings(item.acceptance) &&
        strings(item.nonGoals),
    )
  )
    return { kind: 'requirements', entries: value };
  if (
    role === 'ARCHITECT' &&
    record(value) &&
    record(value.architecture) &&
    record(value.conventions) &&
    Object.keys(value).every((key) => key === 'architecture' || key === 'conventions')
  ) {
    return {
      kind: 'architecture',
      architecture: value.architecture,
      conventions: value.conventions,
    };
  }
  if (
    role !== 'REVIEWER' ||
    !Array.isArray(value) ||
    !value.every((item) => record(item) && typeof item.kind === 'string')
  )
    return;
  const verdicts = value.filter((item) => item.kind === 'verdict');
  if (verdicts.length !== 1) return;
  const verdict = verdicts[0];
  if (
    !verdict ||
    typeof verdict.id !== 'string' ||
    !safeId.test(verdict.id) ||
    !['approved', 'changes_requested'].includes(verdict.verdict) ||
    typeof verdict.summary !== 'string' ||
    !verdict.summary ||
    (verdict.issueScope !== undefined &&
      !['implementation', 'architecture'].includes(verdict.issueScope)) ||
    (verdict.verdict === 'approved' && verdict.issueScope === 'architecture') ||
    (verdict.subtaskIds !== undefined &&
      (!strings(verdict.subtaskIds) ||
        verdict.subtaskIds.length === 0 ||
        new Set(verdict.subtaskIds).size !== verdict.subtaskIds.length ||
        !verdict.subtaskIds.every((id: string) => safeId.test(id))))
  )
    return;
  return {
    kind: 'review',
    verdict: verdict as Verdict,
    comments: value.filter((item) => item.kind !== 'verdict'),
  };
}

function label(key: string): string {
  if (Object.hasOwn(labels, key)) return labels[key] as string;
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function ReadableValue({ value }: { value: unknown }): React.ReactNode {
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="delivery-empty">None</span>;
    return (
      <ul>
        {value.map((item, index) => (
          <li key={index}>
            <ReadableValue value={item} />
          </li>
        ))}
      </ul>
    );
  }
  if (record(value))
    return (
      <dl>
        {Object.entries(value).map(([key, item]) => (
          <div key={key}>
            <dt>{label(key)}</dt>
            <dd>
              <ReadableValue value={item} />
            </dd>
          </div>
        ))}
      </dl>
    );
  return typeof value === 'string' ? (
    <MessageMarkdown text={value} />
  ) : (
    <span>{value === null ? 'Not specified' : String(value)}</span>
  );
}

function DeliveryBody({ delivery }: { delivery: Delivery }) {
  if (delivery.kind === 'requirement-update')
    return (
      <>
        <h3>Requirement update</h3>
        <span className="delivery-reference">{delivery.entry.id}</span>
        <MessageMarkdown text={delivery.entry.story} />
        <details className="message-original">
          <summary>View criteria and scope</summary>
          <h4>Acceptance criteria</h4>
          <ReadableValue value={delivery.entry.acceptance} />
          <h4>Out of scope</h4>
          <ReadableValue value={delivery.entry.nonGoals} />
        </details>
      </>
    );
  if (delivery.kind === 'requirements')
    return (
      <>
        <h3>
          Requirements <span className="delivery-count">{delivery.entries.length}</span>
        </h3>
        {delivery.entries.map((item, index) => (
          <section className="delivery-section" key={`${item.id}-${index}`}>
            <span className="delivery-reference">{item.id}</span>
            <div className="delivery-story">
              <MessageMarkdown text={item.story} />
            </div>
            <h4>Acceptance criteria</h4>
            <ul>
              {item.acceptance.map((text, i) => (
                <li key={i}>
                  <MessageMarkdown text={text} />
                </li>
              ))}
            </ul>
            {item.nonGoals.length > 0 && (
              <>
                <h4>Out of scope</h4>
                <ul>
                  {item.nonGoals.map((text, i) => (
                    <li key={i}>
                      <MessageMarkdown text={text} />
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>
        ))}
      </>
    );
  if (delivery.kind === 'architecture')
    return (
      <>
        <h3>Implementation plan</h3>
        <section className="delivery-section">
          <h4>Architecture</h4>
          <ReadableValue value={delivery.architecture} />
        </section>
        <section className="delivery-section">
          <h4>Conventions</h4>
          <ReadableValue value={delivery.conventions} />
        </section>
      </>
    );
  const approved = delivery.verdict.verdict === 'approved';
  const references = Object.fromEntries(
    Object.entries(delivery.verdict).filter(
      ([key]) => !['id', 'kind', 'verdict', 'summary'].includes(key),
    ),
  );
  return (
    <>
      <h3 className={approved ? 'delivery-approved' : 'delivery-changes'}>
        {approved ? 'Review approved' : 'Changes requested'}
      </h3>
      <MessageMarkdown text={delivery.verdict.summary} />
      {approved && <p className="delivery-authority">Completion requires Leader confirmation.</p>}
      {Object.keys(references).length > 0 && (
        <section className="delivery-section">
          <ReadableValue value={references} />
        </section>
      )}
      {delivery.comments.length > 0 && (
        <section className="delivery-section">
          <h4>Review notes</h4>
          <ReadableValue value={delivery.comments} />
        </section>
      )}
    </>
  );
}

export const MessageContent = React.memo(function MessageContent({
  role,
  display,
}: {
  role: string;
  display: string;
}) {
  const delivery = deliveryFromDisplay(role, display);
  if (!delivery) return <MessageMarkdown text={display} />;
  return (
    <div className="message-delivery">
      <DeliveryBody delivery={delivery} />
      <details className="message-original">
        <summary>View original message</summary>
        <pre>{display}</pre>
      </details>
    </div>
  );
});
