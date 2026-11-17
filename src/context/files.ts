import * as fs from 'node:fs';
import * as path from 'node:path';

const IGNORED_DIRS = new Set([
  '.git',
  '.venv',
  'venv',
  'node_modules',
  'out',
  'dist',
  '__pycache__',
  '.tox',
  'build',
  '.idea',
  '.vscode',
]);

const MAX_FILE_BYTES = 300_000;

function toPosix(rel: string): string {
  return rel.split(path.sep).join('/');
}

function isBinary(sample: Buffer): boolean {
  return sample.includes(0);
}

/** All indexable files under root, workspace-relative posix paths. */
export function listFiles(rootDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.') && !IGNORED_DIRS.has(entry.name)) {
          walk(full);
        }
        continue;
      }
      if (entry.name.startsWith('.')) {
        continue; // never index dotfiles (.env secrets included)
      }
      try {
        const stat = fs.statSync(full);
        if (stat.size > MAX_FILE_BYTES || stat.size === 0) {
          continue;
        }
        const fd = fs.openSync(full, 'r');
        const sample = Buffer.alloc(Math.min(8192, stat.size));
        fs.readSync(fd, sample, 0, sample.length, 0);
        fs.closeSync(fd);
        if (isBinary(sample)) {
          continue;
        }
        out.push(toPosix(path.relative(rootDir, full)));
      } catch {
        // Unreadable file; skip it.
      }
    }
  };
  walk(rootDir);
  return out.sort();
}
