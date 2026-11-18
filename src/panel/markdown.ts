import { marked } from 'marked';

/**
 * Model replies render as HTML in the panel. Raw HTML is demoted to
 * visible text and dangerous link schemes are neutered; the webview CSP
 * (no inline scripts, no remote loads) is the backstop.
 */
marked.use({
  breaks: true,
  walkTokens(token) {
    if (token.type === 'html' || token.type === 'inlineHtml') {
      token.type = 'text';
    }
    if (token.type === 'link' && /^(javascript|data|vbscript):/i.test(token.href ?? '')) {
      token.type = 'text';
    }
  },
});

/** Markdown to safe HTML. Synchronous for walkTokens-only extensions. */
export function renderMarkdown(source: string): string {
  return marked.parse(source) as string;
}
