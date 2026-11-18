import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Every contributed command must be reachable: either a matching
 * onCommand activation event exists, or activation is eager (*).
 * Missing events surface as "command ... not found" on first invoke.
 */
describe('activation events', () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'package.json'), 'utf8'),
  ) as {
    activationEvents: string[];
    contributes: { commands: Array<{ command: string }> };
  };

  it('covers every contributed command', () => {
    const events: string[] = manifest.activationEvents ?? [];
    if (events.includes('*')) {
      return;
    }
    const missing = manifest.contributes.commands
      .map((entry) => entry.command)
      .filter((command) => !events.includes(`onCommand:${command}`));
    assert.deepEqual(missing, []);
  });
});
