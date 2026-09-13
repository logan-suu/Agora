'use client';

import type { RequirementChange, RequirementProposalView } from '@agora/core-domain';
import * as React from 'react';

function RequirementText({ value }: { value: RequirementChange['requirement'] | null }) {
  if (!value) return <p className="proposal-empty">New requirement</p>;
  return (
    <React.Fragment>
      <p>{value.story}</p>
      <strong>Acceptance criteria</strong>
      <ul>
        {value.acceptance.map((text, index) => (
          <li key={`${index}:${text}`}>{text}</li>
        ))}
      </ul>
      {value.nonGoals.length > 0 ? (
        <React.Fragment>
          <strong>Out of scope</strong>
          <ul>
            {value.nonGoals.map((text, index) => (
              <li key={`${index}:${text}`}>{text}</li>
            ))}
          </ul>
        </React.Fragment>
      ) : null}
    </React.Fragment>
  );
}

export function RequirementProposalCard({
  proposal,
  busy,
  onRespond,
}: {
  proposal: RequirementProposalView;
  busy: boolean;
  onRespond: (action: 'confirm' | 'dismiss') => void;
}) {
  const stale = proposal.status === 'stale';
  return (
    <section
      className="requirement-proposal"
      aria-label="Proposed requirement changes"
      aria-busy={busy}
    >
      <h3>Review requirement changes</h3>
      <p>
        {stale
          ? 'This proposal is out of date. Describe the change again to get an updated proposal.'
          : 'Nothing has changed yet. Review the full changes before confirming.'}
      </p>
      {proposal.changes.map((change, index) => (
        <details key={change.requirementId} open={index === 0}>
          <summary>
            Change {index + 1}: {change.after.story}
          </summary>
          <div className="proposal-comparison">
            <div>
              <h4>Before</h4>
              <RequirementText value={change.before} />
            </div>
            <div>
              <h4>After</h4>
              <RequirementText value={change.after} />
            </div>
          </div>
        </details>
      ))}
      <div className="proposal-actions">
        <button type="button" disabled={busy || stale} onClick={() => onRespond('confirm')}>
          Confirm changes
        </button>
        <button type="button" disabled={busy} onClick={() => onRespond('dismiss')}>
          Discard proposal
        </button>
        {busy ? <span role="status">Submitting your choice…</span> : null}
      </div>
    </section>
  );
}
