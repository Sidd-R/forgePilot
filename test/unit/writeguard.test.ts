import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Eligibility-adjacent safety rule: only `src/edits/proposals.ts` may write
 * to disk or apply workspace edits. Every other module must route writes
 * through the proposal store. This test statically enforces that.
 */
describe('single disk-write path', () => {
  const srcDir = path.resolve(__dirname, '..', '..', '..', 'src');
  const allowed = new Set([path.join(srcDir, 'edits', 'proposals.ts')]);

  const offenders: string[] = [];

  function scan(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scan(full);
        continue;
      }
      if (!entry.name.endsWith('.ts') || allowed.has(full)) {
        continue;
      }
      const text = fs.readFileSync(full, 'utf8');
      const lines = text.split('\n');
      lines.forEach((line, i) => {
        const stripped = line.split('//')[0];
        if (
          /\bfs\.(writeFile|appendFile|createWriteStream)\b/.test(stripped) ||
          /\b(writeFileSync|appendFileSync)\b/.test(stripped) ||
          /\bworkspace\.applyEdit\b/.test(stripped) ||
          /\.applyEdit\b/.test(stripped)
        ) {
          offenders.push(`${path.relative(srcDir, full)}:${i + 1}: ${line.trim()}`);
        }
      });
    }
  }

  it('no module outside edits/proposals.ts writes files or applies edits', () => {
    if (!fs.existsSync(srcDir)) {
      return; // scaffold stage: nothing to scan yet
    }
    scan(srcDir);
    assert.deepEqual(offenders, []);
  });
});
