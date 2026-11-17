/**
 * Fenced-block fallback: when the inline agent answers with text instead
 * of a tool call, the first fenced code block is the replacement.
 * Returns null when no usable block exists.
 */
export function parseFencedBlock(reply: string): string | null {
  const lines = reply.split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^```[\w+-]*\s*$/.test(lines[i].trim())) {
      start = i;
      break;
    }
  }
  if (start === -1) {
    return null;
  }
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim() === '```') {
      const block = lines
        .slice(start + 1, i)
        .join('\n')
        .replace(/\n$/, '');
      return block ? block : null;
    }
  }
  return null;
}
