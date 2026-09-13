import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MessageContent } from '../src/app/message-content';

const render = (display: string, role = 'CODER') =>
  renderToStaticMarkup(createElement(MessageContent, { role, display }));

describe('chat Markdown presentation', () => {
  it('folds a tagged JSON result after readable prose and preserves the exact report', () => {
    const report =
      '<agora-result>\n{"role":"TESTER","summary":"<script>bad</script>","results":{"passed":26}}\n</agora-result>';
    const markup = render(`**Validation complete.**\n\n${report}\n\nReady for review.`, 'TESTER');
    expect(markup).toContain('<strong>Validation complete.</strong>');
    expect(markup).toContain('<summary>View result details</summary>');
    expect(markup).toContain('&lt;agora-result&gt;\n{&quot;role&quot;:&quot;TESTER&quot;');
    expect(markup).toContain('&lt;/agora-result&gt;');
    expect(markup).toContain('Ready for review.');
    expect(markup).not.toContain('<script>');
    expect(markup).not.toContain('<details open');
    expect(markup.split('<details')[0]).not.toContain('&quot;results&quot;');
  });

  it('keeps malformed result tags and code examples visible', () => {
    for (const text of [
      '<agora-result>\n{invalid}\n</agora-result>',
      '<agora-result>\n{"status":"ok"}',
      '<agora-result>\nnull\n</agora-result>',
      '<other-result>\n{"status":"ok"}\n</other-result>',
      '```text\n<agora-result>\n{"status":"ok"}\n</agora-result>\n```',
      '`<agora-result>{"status":"ok"}</agora-result>`',
    ]) {
      expect(render(text)).not.toContain('View result details');
      expect(render(text)).toContain('&lt;');
    }
  });

  it('keeps report prose visible while folding JSON details without changing the code', () => {
    const markup = render(
      'Implemented **ticket.mjs**.\n\n```json\n{"role":"CODER","summary":"Done"}\n```',
    );
    expect(markup).toContain('<strong>ticket.mjs</strong>');
    expect(markup).toContain(
      '<details class="message-original"><summary>View JSON details</summary>',
    );
    expect(markup).toContain('<code class="language-json">{&quot;role&quot;:&quot;CODER&quot;');
    expect(markup).not.toContain('<details open');
    expect(markup.split('<details')[0]).not.toContain('&quot;role&quot;');
    expect(render('```json\n{invalid}\n```')).not.toContain('View JSON details');
    expect(render('```js\nconst x = 1;\n```')).not.toContain('View JSON details');
  });

  it('renders headings, emphasis, lists, quotes and links for every speaker', () => {
    for (const role of ['leader', 'CODER', 'CUSTOM']) {
      const markup = render(
        '# Plan\n\n**Ready** and *reviewed*\n\n- Build\n- Test\n\n> Evidence\n\n[Docs](https://example.com/docs)',
        role,
      );
      expect(markup).toContain('<h1>Plan</h1>');
      expect(markup).toContain('<strong>Ready</strong>');
      expect(markup).toContain('<em>reviewed</em>');
      expect(markup).toContain('<li>Build</li>');
      expect(markup).toContain('<blockquote>');
      expect(markup).toContain('href="https://example.com/docs"');
    }
  });

  it('renders GFM tables and read-only checklists', () => {
    const markup = render(
      '| Item | Status |\n| --- | --- |\n| API | Pass |\n\n- [x] Tested\n- [ ] Reviewed',
    );
    expect(markup).toContain('class="markdown-table-scroll"');
    expect(markup).toContain('<table>');
    expect(markup).toContain('<td>Pass</td>');
    expect(markup).toContain('type="checkbox" disabled="" checked=""');
  });

  it('highlights mentions in prose and emphasis but never in inline or fenced code', () => {
    const markup = render(
      '@CODER ask **@TESTER**\n\n`@CODER <tag>`\n\n```ts\nconst role = "@REVIEWER";\n```',
    );
    expect(markup).toContain('<span class="mention">@CODER</span>');
    expect(markup).toContain('<strong><span class="mention">@TESTER</span></strong>');
    expect(markup).toContain('<code>@CODER &lt;tag&gt;</code>');
    expect(markup).toContain('<pre><code class="language-ts">const role = &quot;@REVIEWER&quot;;');
    expect(markup.match(/class="mention"/g)).toHaveLength(2);
  });

  it('keeps raw HTML inert and blocks unsafe URLs without loading external images', () => {
    const markup = render(
      '<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[bad](javascript:alert%281%29)\n\n![Diagram](https://example.com/diagram.png)',
    );
    expect(markup).not.toContain('<script');
    expect(markup).not.toContain('<img');
    expect(markup).not.toContain('href="javascript:');
    expect(markup).toContain('&lt;script&gt;');
    expect(markup).toContain('href="https://example.com/diagram.png"');
    expect(markup).toContain('Diagram');
  });

  it('renders Markdown inside known deliveries while preserving the exact original', () => {
    const pm = render(
      JSON.stringify([
        {
          id: 'req-1',
          story: 'Use **900 cents**',
          acceptance: ['Return `1800`'],
          nonGoals: ['No *payments*'],
        },
      ]),
      'PM',
    );
    expect(pm).toContain('<strong>900 cents</strong>');
    expect(pm).toContain('<code>1800</code>');
    expect(pm).toContain('Use **900 cents**');
    const arch = render(
      JSON.stringify({
        architecture: { notes: '## Modules\n\nUse `ticket.mjs`' },
        conventions: { tests: '**node --test**' },
      }),
      'ARCHITECT',
    );
    expect(arch).toContain('<h2>Modules</h2>');
    expect(arch).toContain('<strong>node --test</strong>');
    const review = render(
      JSON.stringify([
        { id: 'v-1', kind: 'verdict', verdict: 'approved', summary: '**Passed** all tests.' },
      ]),
      'REVIEWER',
    );
    expect(review).toContain('<strong>Passed</strong>');
    expect(review).toContain('Completion requires Leader confirmation.');
  });

  it('preserves unknown JSON, plain-text line breaks and oversized content', () => {
    expect(render('{"value":"**literal**"}')).not.toContain('<strong>');
    expect(render('First line\nSecond line')).toContain('First line\nSecond line');
    const text = `**literal**${'x'.repeat(100_000)}`;
    const markup = render(text);
    expect(markup).not.toContain('<strong>');
    expect(markup).toContain(text);
  });
});
