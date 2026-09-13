import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DEFAULT_WORKSPACE } from '../src/app/chat-model';
import { ChatWorkspace } from '../src/app/chat-workspace';

function render(role: string, display: string) {
  return renderToStaticMarkup(
    createElement(ChatWorkspace, {
      model: {
        ...DEFAULT_WORKSPACE,
        messages: [{ msgId: 'readable', fromRole: role, display, ts: 0 }],
      },
    }),
  );
}

describe('readable role deliveries', () => {
  it('presents a Leader requirement command without claiming it was applied', () => {
    const command = `/requirement req-ticket ${JSON.stringify({
      story: 'Charge **900 cents** per attendee',
      acceptance: ['Two tickets cost 1800 cents'],
      nonGoals: ['No payment gateway'],
    })}`;
    const markup = render('leader', command);
    expect(markup).toContain('Requirement update');
    expect(markup).toContain('<strong>900 cents</strong>');
    expect(markup).toContain('<summary>View criteria and scope</summary>');
    expect(markup).toContain('Two tickets cost 1800 cents');
    expect(markup).toContain('View original message');
    expect(markup).not.toContain('Requirement applied');
    expect(render('CODER', command)).not.toContain('Requirement update');
    expect(render('leader', '/requirement req-ticket {"story":"incomplete"}')).not.toContain(
      'Requirement update',
    );
  });

  it('renders requirements and acceptance as reading content with a closed original disclosure', () => {
    const markup = render(
      'PM',
      JSON.stringify([
        {
          id: 'req-ticket',
          story: 'Charge 900 cents per attendee',
          acceptance: ['Two tickets cost 1800 cents'],
          nonGoals: ['No payment gateway'],
        },
      ]),
    );
    expect(markup).toContain('Requirements');
    expect(markup).toContain('Acceptance criteria');
    expect(markup).toContain(
      '<li><div class="message-markdown"><p>Two tickets cost 1800 cents</p></div></li>',
    );
    expect(markup).toContain('Out of scope');
    expect(markup).toContain(
      '<details class="message-original"><summary>View original message</summary>',
    );
    expect(markup.split('<details class="message-original">')[0]).not.toContain(
      '&quot;acceptance&quot;',
    );
  });

  it('renders a fenced architecture handoff as nested labelled sections', () => {
    const text =
      '```json\n' +
      JSON.stringify({
        architecture: {
          modules: [{ id: 'A', file: 'ticket.mjs', exports: ['ticketCost'] }],
          executionPlan: {
            version: 1,
            subtasks: [{ id: 'A', title: 'Implement tickets', dependsOn: [] }],
          },
        },
        conventions: { testing: 'node --test' },
      }) +
      '\n```';
    const markup = render('ARCHITECT', text);
    expect(markup).toContain('Implementation plan');
    expect(markup).toContain('Execution plan');
    expect(markup).toContain('Dependencies');
    expect(markup).toContain('ticket.mjs');
    expect(markup).toContain('Conventions');
  });

  it('distinguishes reviewer approval from Leader completion', () => {
    const markup = render(
      'REVIEWER',
      JSON.stringify([
        { id: 'review-1', kind: 'verdict', verdict: 'approved', summary: 'All 14 tests pass.' },
      ]),
    );
    expect(markup).toContain('Review approved');
    expect(markup).toContain('Completion requires Leader confirmation.');
    expect(markup).not.toContain('Task completed');
    expect(markup).toContain('All 14 tests pass.');
  });

  it('shows requested changes and preserves additional review entries', () => {
    const markup = render(
      'REVIEWER',
      JSON.stringify([
        {
          id: 'review-2',
          kind: 'verdict',
          verdict: 'changes_requested',
          summary: 'Correct the old price.',
          subtaskIds: ['A'],
        },
        { kind: 'comment', message: 'Keep the zero case.', file: 'ticket.test.mjs' },
      ]),
    );
    expect(markup).toContain('Changes requested');
    expect(markup).toContain('Correct the old price.');
    expect(markup).toContain('Keep the zero case.');
    expect(markup).not.toContain('Completion requires Leader confirmation.');
  });

  it.each(['leader', 'CODER', 'CUSTOM'])('preserves ordinary JSON from %s', (role) => {
    const markup = render(role, '[{"example":1}]');
    expect(markup).toContain('[{&quot;example&quot;:1}]');
    expect(markup).not.toContain('message-original');
  });

  it.each([
    '[{"id":"bad"}]',
    '{invalid JSON}',
    'Please inspect {"example":1}',
    '[{"kind":"verdict","verdict":"unknown","summary":"test"}]',
  ])('does not reinterpret incomplete or unknown deliveries', (text) => {
    expect(render('PM', text)).not.toContain('message-original');
    expect(render('REVIEWER', text)).not.toContain('message-original');
  });

  it('escapes HTML in both formatted text and the original', () => {
    const markup = render(
      'PM',
      JSON.stringify([
        {
          id: 'r',
          story: '<script>alert(1)</script>',
          acceptance: ['<img src=x onerror=alert(1)>'],
          nonGoals: [],
        },
      ]),
    );
    expect(markup).not.toContain('<script>');
    expect(markup).not.toContain('<img src=x');
    expect(markup).toContain('&lt;script&gt;');
  });

  it('keeps deeply nested content as original text instead of recursively rendering it', () => {
    let architecture: unknown = 'nested';
    for (let i = 0; i < 30; i++) architecture = { nested: architecture };
    expect(render('ARCHITECT', JSON.stringify({ architecture, conventions: {} }))).not.toContain(
      'message-original',
    );
  });

  it('renders prototype-shaped labels as text and refuses competing verdicts', () => {
    const markup = render(
      'ARCHITECT',
      '{"architecture":{"constructor":"A label","__proto__":"Another label"},"conventions":{}}',
    );
    expect(markup).toContain('A label');
    expect(markup).toContain('Another label');
    const verdict = { id: 'v', kind: 'verdict', verdict: 'approved', summary: 'approved' };
    expect(
      render('REVIEWER', JSON.stringify([verdict, { ...verdict, id: 'other' }])),
    ).not.toContain('Review approved');
  });
});
