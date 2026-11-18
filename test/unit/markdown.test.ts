import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../../src/panel/markdown';

describe('renderMarkdown', () => {
  it('renders common markdown', () => {
    const html = renderMarkdown('# Title\n\nSome **bold** and `code`.\n\n- one\n- two\n');
    assert.match(html, /<h1[^>]*>Title<\/h1>/);
    assert.match(html, /<strong>bold<\/strong>/);
    assert.match(html, /<code>code<\/code>/);
    assert.match(html, /<li>one<\/li>/);
  });

  it('renders fenced code blocks with language', () => {
    const html = renderMarkdown('```python\nprint(1)\n```');
    assert.match(html, /<pre><code class="language-python">/);
    assert.match(html, /print\(1\)/);
  });

  it('demotes raw HTML to visible text', () => {
    const html = renderMarkdown('a <img src="x" onerror="y()"> b');
    assert.doesNotMatch(html, /<img/);
    assert.match(html, /&lt;img/);
  });

  it('neuters dangerous links but keeps safe ones', () => {
    const html = renderMarkdown('[x](javascript:alert(1)) [y](https://ok.com)');
    assert.doesNotMatch(html, /javascript:/);
    assert.match(html, /<a href="https:\/\/ok\.com">y<\/a>/);
  });

  it('keeps code content intact', () => {
    const html = renderMarkdown('`<div>`');
    assert.match(html, /<code>&lt;div&gt;<\/code>/);
  });
});
