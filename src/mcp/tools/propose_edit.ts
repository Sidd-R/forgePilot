import { z } from 'zod';
import type { McpToolDef } from '../server';
import type { Proposal } from '../../types';
import {
  ProposalStore,
  createProposal,
  hashArgs,
} from '../../edits/proposals';
import { AlreadyAppliedError, MatchError, isAlreadyApplied } from '../../edits/matcher';
import { resolveInside } from './jail';

const fileEditSchema = z.object({
  path: z.string().describe('Workspace-relative file path.'),
  edits: z
    .array(z.object({ old_text: z.string(), new_text: z.string() }))
    .optional()
    .describe('Search-and-replace blocks. Omit when content is used.'),
  content: z.string().optional().describe('Whole-file content for new or small files.'),
  explanation: z.string().optional().describe('Why this file changes.'),
});

export type FileEditArgs = z.infer<typeof fileEditSchema>;

export const proposeEditSchema = z.object({
  path: z.string().optional().describe('Workspace-relative file path (single-file call).'),
  edits: z
    .array(z.object({ old_text: z.string(), new_text: z.string() }))
    .optional()
    .describe('Search-and-replace blocks. Omit when content is used.'),
  content: z.string().optional().describe('Whole-file content for new or small files.'),
  explanation: z.string().optional().describe('Why this change is needed.'),
  files: z
    .array(fileEditSchema)
    .optional()
    .describe(
      'Batch several files into ONE call so the user reviews everything together. ' +
        'Prefer one call with all files over many single-file calls.',
    ),
});

export type ProposeEditArgs = z.infer<typeof proposeEditSchema>;

/** Single-file fields plus batched files, in call order. */
export function fileListOf(args: ProposeEditArgs): FileEditArgs[] {
  const out: FileEditArgs[] = [];
  if (args.path !== undefined) {
    out.push({ path: args.path, edits: args.edits, content: args.content, explanation: args.explanation });
  }
  for (const file of args.files ?? []) {
    out.push(file);
  }
  return out;
}

export interface ProposeEditDeps {
  rootDir: string;
  store: ProposalStore;
  readText: (relPath: string) => Promise<string | null>;
  writeFinal: (relPath: string, text: string) => Promise<void>;
}

/** Hash input shape. prepare and apply must hash identically. */
function hashInput(files: Array<{ rel: string; edits?: unknown; content?: string }>): string {
  return hashArgs(files.map((file) => ({ path: file.rel, edits: file.edits, content: file.content })));
}

/**
 * Pause-time: build one proposal per file and stage them for a single
 * combined review. All-or-nothing: any failure stages nothing, and the
 * caller turns the message into a deny reason so the model can retry.
 */
export async function prepareProposals(
  deps: ProposeEditDeps,
  runId: string,
  nextId: () => string,
  rawArgs: Record<string, unknown>,
): Promise<Array<{ proposal: Proposal; newText: string }>> {
  const parsed = proposeEditSchema.parse(rawArgs);
  const files = fileListOf(parsed);
  if (files.length === 0) {
    throw new Error('propose_edit needs a path or files.');
  }
  const jailed = files.map((file) => ({ ...file, rel: resolveInside(deps.rootDir, file.path).rel }));
  const callHash = hashInput(jailed);
  const built: Array<{ proposal: Proposal; newText: string; current: string | null }> = [];
  for (const file of jailed) {
    const current = await deps.readText(file.rel);
    if (current !== null && file.content === undefined && !file.edits?.length) {
      throw new Error(`propose_edit for ${file.rel} needs edits or content.`);
    }
    try {
      const one = createProposal(
        nextId(),
        file.rel,
        current,
        { edits: file.edits, content: file.content, explanation: file.explanation },
        callHash,
      );
      if (one.proposal.hunks.length === 0) {
        throw new Error(
          `propose_edit changes nothing in ${file.rel}; drop it or fix old_text.`,
        );
      }
      built.push({ ...one, current });
    } catch (err) {
      if (err instanceof MatchError && current !== null && isAlreadyApplied(current, file.edits)) {
        throw new AlreadyAppliedError();
      }
      throw err;
    }
  }
  for (const one of built) {
    deps.store.addProposal(runId, one.proposal, one.current);
  }
  return built;
}

/** Single-file prepare, kept for the inline fenced path and older tests. */
export async function prepareProposal(
  deps: ProposeEditDeps,
  runId: string,
  proposalId: string,
  rawArgs: Record<string, unknown>,
): Promise<{ proposal: Proposal; newText: string }> {
  const [only] = await prepareProposals(deps, runId, () => proposalId, rawArgs);
  if (!only) {
    throw new Error('propose_edit needs a path or files.');
  }
  return only;
}

export interface ApplyOutcome {
  applied: string[];
  rejected: string[];
  note?: string;
}

/**
 * Tool-time: apply the recorded hunk decisions. TrueForge only calls the
 * tool after the user allowed it, but the handler re-verifies: unknown
 * hash (no review happened) or a file changed since review both refuse.
 */
export async function applyPreparedProposal(
  deps: ProposeEditDeps,
  rawArgs: Record<string, unknown>,
): Promise<ApplyOutcome> {
  const parsed = proposeEditSchema.parse(rawArgs);
  const files = fileListOf(parsed);
  if (files.length === 0) {
    throw new Error('propose_edit needs a path or files.');
  }
  const jailed = files.map((file) => ({
    edits: file.edits,
    content: file.content,
    rel: resolveInside(deps.rootDir, file.path).rel,
  }));
  const found = deps.store.findAllByHash(hashInput(jailed));
  if (found.length === 0) {
    throw new Error(
      'No recorded user decision for this edit; it was never reviewed. Rejecting.',
    );
  }
  const applied: string[] = [];
  const rejected: string[] = [];
  const multi = found.length > 1;
  for (const match of found) {
    const outcome = await applyDecidedProposal(deps, match.runId, match.proposal.id);
    const tag = (id: string): string =>
      multi ? `${match.proposal.path}:${id}` : id;
    applied.push(...outcome.applied.map(tag));
    rejected.push(...outcome.rejected.map(tag));
  }
  return {
    applied,
    rejected,
    note:
      rejected.length > 0
        ? `User rejected hunks ${rejected.join(', ')}; do not resend them unchanged.`
        : undefined,
  };
}

/**
 * Apply a fully-reviewed proposal's accepted hunks, with the same
 * staleness guard. Used by the tool path and the inline fenced path.
 */
export async function applyDecidedProposal(
  deps: ProposeEditDeps,
  runId: string,
  proposalId: string,
): Promise<ApplyOutcome> {
  const proposal = deps.store.getProposal(runId, proposalId);
  if (!proposal) {
    throw new Error('Unknown proposal.');
  }
  const final = deps.store.finalizedText(runId, proposalId);
  const current = await deps.readText(final.path);
  if (current !== final.before && current !== final.text) {
    throw new Error(
      `File ${final.path} changed since review; refusing to apply a stale proposal. Re-read it first.`,
    );
  }
  if (current !== final.text) {
    await deps.writeFinal(final.path, final.text);
  }
  const applied = proposal.hunks.filter((h) => h.decision === 'accepted').map((h) => h.id);
  const rejected = proposal.hunks.filter((h) => h.decision === 'rejected').map((h) => h.id);
  return {
    applied,
    rejected,
    note:
      rejected.length > 0
        ? `User rejected hunks ${rejected.join(', ')}; do not resend them unchanged.`
        : undefined,
  };
}

export function makeProposeEdit(deps: ProposeEditDeps): McpToolDef {
  return {
    name: 'propose_edit',
    description:
      'Propose file edits for user review. Batch every file the task needs into ONE call ' +
      'with files[] so the user reviews everything together; smallest edit that works per file.',
    inputSchema: proposeEditSchema.shape,
    annotations: { readOnlyHint: false },
    handler: async (args) => {
      try {
        const outcome = await applyPreparedProposal(deps, args);
        const lines = [
          `Applied hunks: ${outcome.applied.join(', ') || 'none'}.`,
          `Rejected hunks: ${outcome.rejected.join(', ') || 'none'}.`,
        ];
        if (outcome.note) {
          lines.push(outcome.note);
        }
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: message }], isError: true };
      }
    },
  };
}
