import * as path from 'node:path';

/** Error the model can read: the path is outside the workspace. */
export class JailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JailError';
  }
}

const EXCLUDED = new Set([
  '.git',
  '.venv',
  'venv',
  'node_modules',
  'out',
  'dist',
  '__pycache__',
  '.tox',
  'build',
]);

export interface JailedPath {
  /** Absolute path, safe to pass to fs. */
  abs: string;
  /** Workspace-relative posix path. */
  rel: string;
}

/**
 * Resolve a tool-provided path inside the workspace root. Rejects escapes
 * (`..`, absolute paths outside) and excluded directories. Throws JailError.
 */
export function resolveInside(rootDir: string, userPath: string): JailedPath {
  const root = path.resolve(rootDir);
  const abs = path.resolve(root, userPath);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new JailError(`Path ${userPath} is outside the workspace.`);
  }
  const rel = path.relative(root, abs).split(path.sep).join('/');
  for (const segment of rel.split('/')) {
    if (EXCLUDED.has(segment) || segment === '.env') {
      throw new JailError(`Path ${userPath} is excluded from tool access.`);
    }
  }
  return { abs, rel };
}
