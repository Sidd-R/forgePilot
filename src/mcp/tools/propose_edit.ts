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

export const proposeEditSchema = z.object({
  path: z.string().describe('Workspace-relative file path.'),
  edits: z
    .array(z.object({ old_text: z.string(), new_text: z.string() }))
    .optional()
    .describe('Search-and-replace blocks. Omit when content is used.'),
  content: z.string().optional().describe('Whole-file content for new or small files.'),
  explanation: z.string().optional().describe('Why this change is needed.'),
});

export type ProposeEditArgs = z.infer<typeof proposeEditSchema>;

export interface ProposeEditDeps {
  rootDir: string;
  store: ProposalStore;
  readText: (relPath: string) => Promise<string | null>;
  writeFinal: (relPath: string, text: string) => Promise<void>;
}

/** Hash input shape. prepare and apply must hash identically. */
function hashInput(rel: string, args: ProposeEditArgs): string {
  return hashArgs({ path: rel, edits: args.edits, content: args.content });
}

/**
 * Pause-time: build the proposal from the tool-call arguments and stage
 * it for review. Throws MatchError/JailError with model-readable text;
 * the caller turns that into a deny reason so the model can retry.
 */
export async function prepareProposal(
  deps: ProposeEditDeps,
  runId: string,
  proposalId: string,
  rawArgs: Record<string, unknown>,
): Promise<{ proposal: Proposal; newText: string }> {
  const parsed = proposeEditSchema.parse(rawArgs);
  const { rel } = resolveInside(deps.rootDir, parsed.path);
  const current = await deps.readText(rel);
  if (current !== null && parsed.content === undefined && !parsed.edits?.length) {
    throw new Error('propose_edit needs edits or content.');
  }
  let built;
  try {
    built = createProposal(
      proposalId,
      rel,
      current,
      { edits: parsed.edits, content: parsed.content, explanation: parsed.explanation },
      hashInput(rel, parsed),
    );
  } catch (err) {
    if (
      err instanceof MatchError &&
      current !== null &&
      isAlreadyApplied(current, parsed.edits)
    ) {
      throw new AlreadyAppliedError();
    }
    throw err;
  }
  const { proposal, newText } = built;
  if (proposal.hunks.length === 0) {
    throw new Error('propose_edit changes nothing; the file already has this content.');
  }
  deps.store.addProposal(runId, proposal, current);
  return { proposal, newText };
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
  const { rel } = resolveInside(deps.rootDir, parsed.path);
  const found = deps.store.findByHash(hashInput(rel, parsed));
  if (!found) {
    throw new Error(
      'No recorded user decision for this edit; it was never reviewed. Rejecting.',
    );
  }
  return applyDecidedProposal(deps, found.runId, found.proposal.id);
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
      'Propose a file edit for user review. One file per call; smallest edit that works.',
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
