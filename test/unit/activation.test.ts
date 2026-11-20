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

describe('manifest contributions', () => {
  const root = path.resolve(__dirname, '..', '..', '..');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
    contributes: {
      commands: Array<{ command: string }>;
      keybindings: Array<{ command: string }>;
      menus: Record<string, Array<{ command: string }>>;
      viewsContainers: { activitybar: Array<{ id: string; icon: string }> };
      views: Record<string, Array<{ id: string }>>;
    };
  };
  const declared = new Set(manifest.contributes.commands.map((entry) => entry.command));

  it('only references declared commands from menus and keybindings', () => {
    const referenced = [
      ...manifest.contributes.keybindings.map((entry) => entry.command),
      ...Object.values(manifest.contributes.menus).flatMap((items) => items.map((i) => i.command)),
    ];
    assert.deepEqual(referenced.filter((command) => !declared.has(command)), []);
  });

  it('ships the activity bar icon and hosts the panel view in its container', () => {
    for (const container of manifest.contributes.viewsContainers.activitybar) {
      assert.ok(fs.existsSync(path.join(root, container.icon)), container.icon);
      assert.ok(manifest.contributes.views[container.id]?.some((v) => v.id === 'forgePilot.panel'));
    }
  });

  it('registers every declared command in extension.ts', () => {
    const source = fs.readFileSync(path.join(root, 'src', 'extension.ts'), 'utf8');
    const missing = [...declared].filter((command) => !source.includes(`'${command}'`));
    assert.deepEqual(missing, []);
  });
});
