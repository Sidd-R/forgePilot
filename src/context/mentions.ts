import * as path from 'node:path';
import type { CodeIndex } from './index';

const STOPWORDS = new Set(
  'a,an,the,that,this,new,add,make,do,does,and,or,but,for,with,from,to,of,in,on,at,by,as,is,are,was,were,be,been,it,its,it\'s,you,your,we,our,they,their,please,just,also,than,then,there,here,what,which,who,whom,should,could,would,will,can,may,might,must,not,no,yes,if,else,when,while,all,any,each,every,some,such,into,over,under,again,once,only,my,me,hi,hello'.split(
    ',',
  ),
);

/** Request text → search words. */
export function tokenizeRequest(request: string): string[] {
  return request
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((word) => word.length >= 2 && !STOPWORDS.has(word));
}

/** Fuzzy file lookup for @file mentions. */
export function resolveFileMention(index: CodeIndex, query: string): string[] {
  const needle = query.toLowerCase();
  const paths = [...new Set(index.chunks.map((chunk) => chunk.path))];
  const scored = paths
    .map((file) => {
      const lower = file.toLowerCase();
      const base = path.basename(lower);
      let score = -1;
      if (base === needle || file === query) {
        score = 100;
      } else if (base.startsWith(needle)) {
        score = 50;
      } else if (lower.includes(needle)) {
        score = 10;
      }
      return { file, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, 5).map((entry) => entry.file);
}

/** Symbol lookup for @symbol mentions. */
export function resolveSymbolMention(
  index: CodeIndex,
  query: string,
): Array<{ symbol: string; path: string; startLine: number }> {
  const needle = query.toLowerCase();
  const out: Array<{ symbol: string; path: string; startLine: number }> = [];
  for (const [symbol, entries] of index.symbols) {
    if (symbol.toLowerCase().includes(needle)) {
      for (const entry of entries.slice(0, 2)) {
        out.push({ symbol, path: entry.path, startLine: entry.startLine });
      }
    }
    if (out.length >= 10) {
      break;
    }
  }
  return out;
}
