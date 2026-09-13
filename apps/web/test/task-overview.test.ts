import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DEFAULT_WORKSPACE } from '../src/app/chat-model';
import { ChatWorkspace } from '../src/app/chat-workspace';

describe('compact current task overview', () => {
  it('separates identity and status from a collapsed full Markdown goal', () => {
    const goal =
      '# Quote module\n\nImplement **ticketCost**.\n\n- Preserve zero\n- Reject negatives';
    const markup = renderToStaticMarkup(
      createElement(ChatWorkspace, {
        model: {
          ...DEFAULT_WORKSPACE,
          task: { id: 'quote-demo-3', title: goal, status: 'completed' },
        },
      }),
    );
    expect(markup).toContain('<p class="task-id">quote-demo-3</p>');
    expect(markup).toContain('class="task-goal-preview"');
    expect(markup).toContain('<details class="task-goal">');
    expect(markup).not.toContain('<details class="task-goal" open');
    expect(markup).toContain('View full goal');
    expect(markup).toContain('Collapse goal');
    expect(markup).toContain('<strong>ticketCost</strong>');
    expect(markup).toContain('<li>Preserve zero</li>');
    expect(markup).toContain('<li>Reject negatives</li>');
    expect(markup).toContain('Progress');
    expect(markup).toContain('Active workers');
    expect(markup).toContain('Trace');
  });
});
