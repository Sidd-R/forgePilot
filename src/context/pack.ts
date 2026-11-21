import * as path from 'node:path';
import type { ContextItem, ContextPack } from '../types';
import type { Chunk, CodeIndex } from './index';
import { estimateTokens } from './index';
import { tokenizeRequest } from './mentions';
import { baseNameNoExt, partnerFiles } from './partners';

interface Scored {
  chunk: Chunk;
  score: number;
  reasons: string[];
}

/** Data and asset files: never picked on a bare filename match. */
const ASSET_EXT = new Set([
  '.json', '.toml', '.yaml', '.yml', '.css', '.scss', '.html', '.htm', '.txt', '.cfg',
  '.ini', '.lock', '.svg', '.csv', '.xml', '.sql', '.j2', '.jinja',
]);
/** Distinct files the automatic picks may span (mentions not counted). */
const MAX_AUTO_FILES = 12;
/** A single chunk never takes more than this in full text; the rest is truncated. */
const MAX_CHUNK_TOKENS = 1200;
/** Picks scoring below this share of the best pick are noise and left out. */
const MIN_RELATIVE_SCORE = 0.15;
/** A word found in more than this share of files says nothing about the task. */
const GENERIC_FILE_SHARE = 0.4;

const fileTextCache = new WeakMap<CodeIndex, Map<string, string>>();

function fileTexts(index: CodeIndex): Map<string, string> {
  let texts = fileTextCache.get(index);
  if (!texts) {
    texts = new Map();
    for (const chunk of index.chunks) {
      texts.set(chunk.path, `${texts.get(chunk.path) ?? ''}\n${chunk.text.toLowerCase()}`);
    }
    fileTextCache.set(index, texts);
  }
  return texts;
}

/**
 * The request's words, rarest first, minus words that occur in most files
 * of the repo (for Flask: "flask"): those match everything, so they only
 * add noise to ranking and reasons. Keeps every word when all of them are
 * generic or the repo is tiny.
 */
export function specificTokens(index: CodeIndex, tokens: string[]): string[] {
  const unique = [...new Set(tokens)];
  const texts = [...fileTexts(index).values()];
  if (texts.length < 10) {
    return unique;
  }
  const share = new Map(
    unique.map((token) => [
      token,
      texts.filter((text) => text.includes(token)).length / texts.length,
    ]),
  );
  const specific = unique
    .filter((token) => (share.get(token) ?? 0) <= GENERIC_FILE_SHARE)
    .sort((a, b) => (share.get(a) ?? 0) - (share.get(b) ?? 0));
  return specific.length > 0 ? specific : unique;
}

/** Request words found in the chunk, rarest first, at most four. */
function matchedWords(chunk: Chunk, tokens: string[]): string[] {
  const hay = `${chunk.symbol ?? ''} ${chunk.signature} ${chunk.path} ${chunk.text}`.toLowerCase();
  return tokens.filter((token) => hay.includes(token)).slice(0, 4);
}

function addReason(entry: Scored, reason: string): void {
  if (!entry.reasons.includes(reason)) {
    entry.reasons.push(reason);
  }
}

/** Full text capped at MAX_CHUNK_TOKENS, with a pointer to the rest. */
function cappedText(chunk: Chunk): { text: string; endLine: number; tokens: number } {
  if (chunk.tokens <= MAX_CHUNK_TOKENS) {
    return { text: chunk.text, endLine: chunk.endLine, tokens: chunk.tokens };
  }
  const kept: string[] = [];
  let size = 0;
  for (const line of chunk.text.split('\n')) {
    if (size + line.length + 1 > MAX_CHUNK_TOKENS * 4 - 120) {
      break;
    }
    kept.push(line);
    size += line.length + 1;
  }
  const endLine = chunk.startLine + kept.length - 1;
  kept.push(
    `… truncated: read_file ${chunk.path} lines ${endLine + 1}-${chunk.endLine} for the rest`,
  );
  const text = kept.join('\n');
  return { text, endLine, tokens: estimateTokens(text) };
}

export interface PackOptions {
  budget: number;
  mentionedFiles?: string[];
  mentionedSymbols?: string[];
  activeFile?: string;
  openFiles?: string[];
  recentFiles?: string[];
}

/** Ranked, budgeted context pack with a reason attached to every pick. */
export function buildPack(
  index: CodeIndex,
  request: string,
  opts: PackOptions,
): ContextPack {
  const allTokens = tokenizeRequest(request);
  const tokens = specificTokens(index, allTokens);
  const scored = new Map<string, Scored>();
  const get = (chunk: Chunk): Scored => {
    let entry = scored.get(chunk.id);
    if (!entry) {
      entry = { chunk, score: 0, reasons: [] };
      scored.set(chunk.id, entry);
    }
    return entry;
  };
  const chunksByFile = new Map<string, Chunk[]>();
  for (const chunk of index.chunks) {
    const list = chunksByFile.get(chunk.path) ?? [];
    list.push(chunk);
    chunksByFile.set(chunk.path, list);
  }

  // 1. BM25 over chunks, with the request's specific words only.
  for (const hit of index.search(tokens.join(' '), 80)) {
    const entry = get(hit.chunk);
    entry.score += hit.score;
    const words = matchedWords(hit.chunk, tokens);
    if (words.length > 0) {
      addReason(entry, `matched "${words.join('", "')}"`);
    }
  }

  // 2. Exact symbol (code only) and filename (source and docs only) boosts.
  const lowered = new Set(allTokens);
  for (const chunk of index.chunks) {
    if (chunk.symbol && (chunk.kind === 'function' || chunk.kind === 'class')) {
      const full = chunk.symbol.toLowerCase();
      const short = full.slice(full.lastIndexOf('.') + 1);
      if (lowered.has(full) || lowered.has(short)) {
        const entry = get(chunk);
        entry.score += 10;
        addReason(entry, `defines ${chunk.symbol}`);
      }
    }
    const fileWord = baseNameNoExt(chunk.path).toLowerCase();
    if (
      fileWord.length >= 3 &&
      lowered.has(fileWord) &&
      !ASSET_EXT.has(path.extname(chunk.path).toLowerCase())
    ) {
      const entry = get(chunk);
      entry.score += 5;
      addReason(entry, `filename matches "${fileWord}"`);
    }
  }

  // 3. Editor locality boosts.
  const locality = new Map<string, { score: number; reason: string }>();
  if (opts.activeFile) {
    locality.set(opts.activeFile, { score: 4, reason: 'active file' });
  }
  for (const file of opts.openFiles ?? []) {
    locality.set(file, { score: 2, reason: 'open tab' });
  }
  for (const file of opts.recentFiles ?? []) {
    if (!locality.has(file)) {
      locality.set(file, { score: 2, reason: 'recently edited' });
    }
  }
  for (const chunk of index.chunks) {
    const boost = locality.get(chunk.path);
    if (boost) {
      const entry = get(chunk);
      entry.score += boost.score;
      addReason(entry, boost.reason);
    }
  }

  // 4. File-level ranking (best chunk plus a little for further hits), then
  // partner and co-change expansion from the top 5 files. A test or doc
  // partner inherits half its source file's score, so cli.py brings
  // tests/test_cli.py and docs/cli.rst with it.
  const fileScore = (file: string): number => {
    const scores = (chunksByFile.get(file) ?? [])
      .map((chunk) => scored.get(chunk.id)?.score ?? 0)
      .sort((a, b) => b - a);
    return (scores[0] ?? 0) + 0.25 * (scores[1] ?? 0) + 0.1 * (scores[2] ?? 0);
  };
  const scoredFiles = [...new Set([...scored.values()].map((entry) => entry.chunk.path))];
  const topFiles = scoredFiles
    .map((file) => ({ file, score: fileScore(file) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
  const known = new Set(chunksByFile.keys());
  for (const { file, score } of topFiles) {
    for (const partner of partnerFiles(file, known)) {
      if (ASSET_EXT.has(path.extname(partner).toLowerCase())) {
        continue; // tests/static/config.json is fixture data, not a partner
      }
      const kind = partner.includes('test')
        ? 'test'
        : partner.endsWith('.rst') || partner.endsWith('.md')
          ? 'doc'
          : '';
      const reason = kind
        ? `${kind} partner of ${path.basename(file)}`
        : `partner of ${path.basename(file)}`;
      const chunks = chunksByFile.get(partner) ?? [];
      // Lead chunk of the partner: its top scorer, else the one sharing
      // the most request words.
      const lead = [...chunks].sort(
        (a, b) =>
          (scored.get(b.id)?.score ?? 0) - (scored.get(a.id)?.score ?? 0) ||
          matchedWords(b, tokens).length - matchedWords(a, tokens).length,
      )[0];
      if (!lead) {
        continue;
      }
      const leadEntry = get(lead);
      leadEntry.score += Math.max(2, score * 0.5);
      addReason(leadEntry, reason);
      for (const chunk of chunks) {
        const entry = scored.get(chunk.id);
        if (entry && entry !== leadEntry) {
          entry.score += 2;
          addReason(entry, reason);
        }
      }
    }
    for (const co of index.cochange.get(file) ?? []) {
      const chunk = chunksByFile.get(co.file)?.[0];
      if (!chunk || co.count < 2) {
        continue;
      }
      const entry = get(chunk);
      entry.score += 1.5;
      addReason(entry, `changed with ${path.basename(file)} in ${co.count} commits`);
    }
  }

  // 5. Explicit mentions first, each capped at half the budget.
  const items: ContextItem[] = [];
  let used = 0;
  const pushChunk = (chunk: Chunk, reason: string, full: boolean): boolean => {
    let body: { text: string; endLine: number; tokens: number };
    if (full) {
      body = cappedText(chunk);
    } else {
      const text = `${chunk.signature}${chunk.doc ? `\n${chunk.doc}` : ''}`;
      body = { text, endLine: chunk.startLine, tokens: estimateTokens(text) };
    }
    if (used + body.tokens > opts.budget) {
      return false;
    }
    used += body.tokens;
    items.push({
      path: chunk.path,
      startLine: chunk.startLine,
      endLine: body.endLine,
      symbol: chunk.symbol,
      reason,
      tokens: body.tokens,
      text: body.text,
    });
    return true;
  };
  const mentionCap = Math.floor(opts.budget / 2);
  for (const file of opts.mentionedFiles ?? []) {
    let fileUsed = 0;
    for (const chunk of chunksByFile.get(file) ?? []) {
      if (fileUsed + chunk.tokens > mentionCap || used + chunk.tokens > opts.budget) {
        break;
      }
      fileUsed += chunk.tokens;
      used += chunk.tokens;
      items.push({
        path: chunk.path,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        symbol: chunk.symbol,
        reason: 'mentioned by user',
        tokens: chunk.tokens,
        text: chunk.text,
      });
    }
  }
  for (const symbol of opts.mentionedSymbols ?? []) {
    for (const entry of index.symbols.get(symbol) ?? []) {
      const chunk = index.chunks.find(
        (c) => c.path === entry.path && c.startLine === entry.startLine,
      );
      if (chunk && used + chunk.tokens <= opts.budget) {
        used += chunk.tokens;
        items.push({
          path: chunk.path,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          symbol: chunk.symbol,
          reason: 'mentioned by user',
          tokens: chunk.tokens,
          text: chunk.text,
        });
      }
    }
  }

  // 6. Automatic picks. Files are ranked (after partner boosts) and the
  // top MAX_AUTO_FILES above the relevance floor are chosen. Pass 1 gives
  // each chosen file its best chunk, in file rank order, so every chosen
  // file is represented and the card reads top-down. Pass 2 adds further
  // chunks (max 3 per file) by chunk score. Full text (each chunk capped)
  // until 60% of the budget is spent, then signatures.
  const mentioned = new Set(opts.mentionedFiles ?? []);
  const rankedFiles = [...new Set([...scored.values()].map((entry) => entry.chunk.path))]
    .filter((file) => !mentioned.has(file))
    .map((file) => ({ file, score: fileScore(file) }))
    .sort((a, b) => b.score - a.score);
  const floor = (rankedFiles[0]?.score ?? 0) * MIN_RELATIVE_SCORE;
  const chosen = rankedFiles
    .filter((entry) => entry.score >= floor)
    .slice(0, MAX_AUTO_FILES)
    .map((entry) => entry.file);
  const bestChunks = (file: string): Scored[] =>
    (chunksByFile.get(file) ?? [])
      .map((chunk) => scored.get(chunk.id))
      .filter((entry): entry is Scored => entry !== undefined)
      .sort((a, b) => b.score - a.score);
  const perFile = new Map<string, number>();
  const taken = new Set<string>();
  const take = (entry: Scored, rank: number): void => {
    const full = used < opts.budget * 0.6 || rank < 3;
    if (pushChunk(entry.chunk, entry.reasons.join('; ') || 'related', full)) {
      perFile.set(entry.chunk.path, (perFile.get(entry.chunk.path) ?? 0) + 1);
      taken.add(entry.chunk.id);
    }
  };
  chosen.forEach((file, rank) => {
    const best = bestChunks(file)[0];
    if (best) {
      take(best, rank);
    }
  });
  const rest = chosen
    .flatMap((file) => bestChunks(file).slice(1, 3))
    .sort((a, b) => b.score - a.score);
  for (const entry of rest) {
    if (!taken.has(entry.chunk.id) && (perFile.get(entry.chunk.path) ?? 0) < 3) {
      take(entry, chosen.length);
    }
  }

  // 7. Repo outline last, only if it fits.
  let outline: string | undefined;
  const outlineFiles = [
    ...new Set([...topFiles.map((entry) => entry.file), ...index.repoMap.keys()]),
  ].slice(0, 30);
  const outlineText = outlineFiles
    .map((file) => `${file}: ${(index.repoMap.get(file) ?? []).slice(0, 12).join(', ')}`)
    .join('\n');
  const outlineTokens = estimateTokens(outlineText);
  if (outlineText && used + outlineTokens <= opts.budget) {
    outline = outlineText;
    used += outlineTokens;
  }

  return { items, totalTokens: used, budget: opts.budget, outline };
}
