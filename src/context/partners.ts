import * as path from 'node:path';

export function baseNameNoExt(relPath: string): string {
  return path.basename(relPath).replace(/\.[^.]*$/, '');
}

/**
 * Partner files by naming convention: cli.py <-> test_cli.py, docs/cli.rst.
 * Only existing indexed paths are returned.
 */
export function partnerFiles(relPath: string, known: Set<string>): string[] {
  const out: string[] = [];
  const base = baseNameNoExt(relPath);
  const dir = path.dirname(relPath);
  const candidates: string[] = [];
  if (/(^|\/)tests?\//.test(dir) || base.startsWith('test_') || base.endsWith('_test')) {
    const src = base.replace(/^test_/, '').replace(/_test$/, '');
    candidates.push(`src/${src}.py`, `src/flask/${src}.py`, `docs/${src}.rst`);
  } else if (dir === 'docs' || relPath.endsWith('.rst') || relPath.endsWith('.md')) {
    candidates.push(`src/${base}.py`, `src/flask/${base}.py`, `tests/test_${base}.py`);
  } else {
    candidates.push(
      `tests/test_${base}.py`,
      `test/test_${base}.py`,
      `docs/${base}.rst`,
      'CHANGES.rst',
      'CHANGELOG.md',
    );
  }
  for (const candidate of candidates) {
    if (known.has(candidate) && candidate !== relPath) {
      out.push(candidate);
    }
  }
  // Generic fallbacks: same basename anywhere.
  for (const other of known) {
    if (other === relPath || out.includes(other)) {
      continue;
    }
    const otherBase = baseNameNoExt(other);
    if (
      otherBase === base ||
      otherBase === `test_${base}` ||
      base === `test_${otherBase}`
    ) {
      out.push(other);
    }
  }
  return out.slice(0, 4);
}
