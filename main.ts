// main.ts is mend, the CLI SPEC.md specifies (MIT). It does all of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, three-tier line matching, unified diffs, SEARCH/REPLACE blocks,
// V4A patches, JSON edits and the all-or-nothing write. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful move edits, as [old, new] pairs, for the R lines of section 2. */
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** A file's lines (SPEC.md section 3): its own line break, its lines, whether it ends with a break. */
interface FileText {
  br: string;
  lines: string[];
  finalBreak: boolean;
}

function splitFile(text: string): FileText {
  if (text === '') return { br: '\n', lines: [], finalBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) parts.pop();
  return { br, lines: parts, finalBreak };
}

function joinFile(f: FileText): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.finalBreak ? f.br : '');
}

/** Section 5: a line's key at a matching tier (0 exact, 1 trailing ws stripped, 2 both ends stripped). */
function tierKey(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** The 0-based positions where O occurs in the file's lines at one tier; occurrences may overlap. */
function findOccurrences(fileLines: string[], o: string[], tier: number): number[] {
  const oKeys = o.map((l) => tierKey(l, tier));
  const fKeys = fileLines.map((l) => tierKey(l, tier));
  const out: number[] = [];
  for (let i = 0; i + o.length <= fileLines.length; i++) {
    let m = true;
    for (let j = 0; j < o.length; j++) {
      if (fKeys[i + j] !== oKeys[j]) {
        m = false;
        break;
      }
    }
    if (m) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once, with its occurrences; null when it occurs at no tier. */
function findTier(fileLines: string[], o: string[], strict: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = findOccurrences(fileLines, o, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One line of N: its text, and the index into O of the context line it is, or -1 for a new line. */
interface NLine {
  text: string;
  ctxO: number;
}

/**
 * The lines N writes when it replaces O at pos. A context line is written as the file's own matched line.
 * At tier 2 every other line is re-indented: F is the leading whitespace of the file's first matched line,
 * P that of O's first line; a non-empty, non-whitespace line of N starting with P has that P replaced by F.
 * With no matched lines (an insertion) N is written as it is.
 */
function buildReplacement(fileLines: string[], o: string[], n: NLine[], pos: number, tier: number): string[] {
  if (o.length === 0) return n.map((x) => x.text);
  const out: string[] = [];
  const lead = (s: string): string => {
    const m = /^[ \t]*/.exec(s);
    return m === null ? '' : m[0];
  };
  const F = lead(fileLines[pos] ?? '');
  const P = lead(o[0] ?? '');
  for (const item of n) {
    if (item.ctxO >= 0) {
      out.push(fileLines[pos + item.ctxO]!);
    } else if (tier === 2) {
      const t = item.text;
      if (t !== '' && t.trim() !== '' && t.startsWith(P)) out.push(F + t.slice(P.length));
      else out.push(t);
    } else {
      out.push(item.text);
    }
  }
  return out;
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* Section 6: unified diffs. */

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

interface Hunk {
  /** The hunk's -A start line (1-based). */
  a: number;
  /** O: the context and `-` lines, in body order. */
  o: string[];
  /** N: the context and `+` lines, in body order. */
  n: NLine[];
  /** A `\` line follows the hunk's last context or `+` line. */
  backslashAfterLastCtxPlus: boolean;
  /** A `\` line follows the hunk's last `+` line. */
  backslashAfterLastPlus: boolean;
}

function buildHunk(a: number, body: string[]): Hunk {
  const o: string[] = [];
  const n: NLine[] = [];
  for (const bl of body) {
    if (bl.startsWith('\\')) continue;
    if (bl === '' || bl.startsWith(' ')) {
      const text = bl === '' ? '' : bl.slice(1);
      const oi = o.length;
      o.push(text);
      n.push({ text, ctxO: oi });
    } else if (bl.startsWith('-')) {
      o.push(bl.slice(1));
    } else if (bl.startsWith('+')) {
      n.push({ text: bl.slice(1), ctxO: -1 });
    }
  }
  let lastCtxPlus = -1;
  let lastPlus = -1;
  for (let k = 0; k < body.length; k++) {
    const bl = body[k]!;
    if (bl === '' || bl.startsWith(' ') || bl.startsWith('+')) lastCtxPlus = k;
    if (bl.startsWith('+')) lastPlus = k;
  }
  const backslashAfterLastCtxPlus =
    lastCtxPlus >= 0 && body[lastCtxPlus + 1] !== undefined && body[lastCtxPlus + 1]!.startsWith('\\');
  const backslashAfterLastPlus =
    lastPlus >= 0 && body[lastPlus + 1] !== undefined && body[lastPlus + 1]!.startsWith('\\');
  return { a, o, n, backslashAfterLastCtxPlus, backslashAfterLastPlus };
}

interface Section {
  oldPath: string | null;
  newPath: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

/** A path after `--- ` or `+++ `: up to the first tab, surrounding spaces removed, a leading a/ or b/ removed; /dev/null means no file. */
function parseDiffPath(raw: string): string | null {
  let s = raw;
  const tab = s.indexOf('\t');
  if (tab >= 0) s = s.slice(0, tab);
  s = s.trim();
  if (s.startsWith('a/') || s.startsWith('b/')) s = s.slice(2);
  if (s === '/dev/null') return null;
  return s;
}

/** Apply a section's hunks in order to a file's text, following section 6's nearest rule and final-break rules. */
function applyHunks(before: string, hunks: Hunk[], strict: boolean, failPath: string): string {
  const f = splitFile(before);
  let d = 0;
  for (const h of hunks) {
    if (h.o.length === 0) {
      const idx = Math.min(Math.max(h.a + d, 0), f.lines.length);
      const endTouched = idx === f.lines.length;
      const ins = buildReplacement(f.lines, h.o, h.n, idx, 0);
      f.lines.splice(idx, 0, ...ins);
      if (endTouched) f.finalBreak = !h.backslashAfterLastCtxPlus;
      d += h.n.length;
      continue;
    }
    const found = findTier(f.lines, h.o, strict);
    if (found === null) throw new Fail('no-match', failPath);
    const target = h.a - 1 + d;
    let best = found.occ[0]!;
    let bestDist = Math.abs(best - target);
    for (const pos of found.occ) {
      const dist = Math.abs(pos - target);
      if (dist < bestDist) {
        best = pos;
        bestDist = dist;
      }
    }
    const endTouched = best + h.o.length === f.lines.length;
    const rep = buildReplacement(f.lines, h.o, h.n, best, found.tier);
    f.lines.splice(best, h.o.length, ...rep);
    if (endTouched) f.finalBreak = !h.backslashAfterLastCtxPlus;
    d += h.n.length - h.o.length;
  }
  return joinFile(f);
}

function sectionToEdit(sec: Section, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    const isCreate = sec.isCreate || oldP === null;
    const isDelete = !isCreate && (sec.isDelete || newP === null);
    if (isCreate) {
      if (newP === null) return;
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const lines: string[] = [];
      for (const h of sec.hunks) for (const item of h.n) if (item.ctxO < 0) lines.push(item.text);
      let finalBreak = true;
      for (let hi = sec.hunks.length - 1; hi >= 0; hi--) {
        const h = sec.hunks[hi]!;
        if (h.n.some((x) => x.ctxO < 0)) {
          finalBreak = !h.backslashAfterLastPlus;
          break;
        }
      }
      tree.now.set(newP, lines.length === 0 ? '' : lines.join('\n') + (finalBreak ? '\n' : ''));
      return;
    }
    if (isDelete) {
      const p = oldP!;
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (oldP !== newP) {
      const before = tree.get(oldP!);
      if (before === null) throw new Fail('missing', oldP!);
      if (tree.get(newP!) !== null) throw new Fail('exists', newP!);
      const result = applyHunks(before, sec.hunks, strict, oldP!);
      tree.now.set(oldP!, null);
      tree.now.set(newP!, result);
      tree.moves.push([oldP!, newP!]);
      return;
    }
    const p = oldP!;
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    tree.now.set(p, applyHunks(before, sec.hunks, strict, p));
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  let headerHasPair = false;
  let i = 0;
  const newSection = (oldPath: string | null, newPath: string | null): void => {
    const s: Section = { oldPath, newPath, isCreate: false, isDelete: false, hunks: [] };
    sections.push(s);
    cur = s;
    inHeader = true;
    headerHasPair = false;
  };
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      newSection(m[1]!, m[2]!);
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const oldP = parseDiffPath(line.slice(4));
      const newP = parseDiffPath(lines[i + 1]!.slice(4));
      if (cur === null || !inHeader || headerHasPair) {
        newSection(oldP, newP);
        headerHasPair = true;
      } else {
        cur.oldPath = oldP;
        cur.newPath = newP;
        headerHasPair = true;
      }
      i += 2;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (cur !== null && inHeader) throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_RE.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const a = parseInt(m[1]!, 10);
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const bl = lines[j]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '' || bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+') || bl.startsWith('\\')) {
          body.push(bl);
          j++;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      cur.hunks.push(buildHunk(a, body));
      inHeader = false;
      i = j;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('rename from ') && !headerHasPair) cur.oldPath = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ') && !headerHasPair) cur.newPath = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.isCreate = true;
      else if (line.startsWith('deleted file mode')) cur.isDelete = true;
      i++;
      continue;
    }
    i++;
  }
  return sections.map((s) => sectionToEdit(s, strict));
}

/* Section 7: SEARCH/REPLACE blocks. */

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const f = splitFile(before);
    const found = findTier(f.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0]!;
    const nItems: NLine[] = newLines.map((t) => ({ text: t, ctxO: -1 }));
    const rep = buildReplacement(f.lines, oldLines, nItems, pos, found.tier);
    f.lines.splice(pos, oldLines.length, ...rep);
    tree.now.set(path, joinFile(f));
  };
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const s = i;
    let path: string | null = null;
    for (let k = s - 1; k > prevEnd; k--) {
      const l = lines[k]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    let j = s + 1;
    let eq = -1;
    while (j < lines.length) {
      const l = lines[j]!;
      if (l.trimEnd() === '=======') {
        eq = j;
        break;
      }
      if (l.trimEnd() === '>>>>>>> REPLACE' || l.trimEnd() === '<<<<<<< SEARCH') break;
      j++;
    }
    if (eq < 0) throw new Exit2(`error: parse ${s + 1}`);
    let k = eq + 1;
    let rep = -1;
    while (k < lines.length) {
      const l = lines[k]!;
      if (l.trimEnd() === '>>>>>>> REPLACE') {
        rep = k;
        break;
      }
      if (l.trimEnd() === '<<<<<<< SEARCH') break;
      k++;
    }
    if (rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    edits.push(srEdit(path, lines.slice(s + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

/* Section 8: V4A patches. */

interface V4AChunk {
  anchor: string | null;
  o: string[];
  n: NLine[];
  eof: boolean;
}

function v4aAdd(path: string, raw: string[], hdrLine: number): Edit {
  const fileLines: string[] = [];
  for (let k = 0; k < raw.length; k++) {
    const l = raw[k]!;
    if (l === '') fileLines.push('');
    else if (l.startsWith('+')) fileLines.push(l.slice(1));
    else throw new Exit2(`error: parse ${hdrLine + 1 + k}`);
  }
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDelete(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdate(path: string, raw: string[], hdrLine: number, strict: boolean): Edit {
  let moveTo: string | null = null;
  let idx = 0;
  if (raw.length > 0 && raw[0]!.startsWith('*** Move to: ')) {
    moveTo = raw[0]!.slice('*** Move to: '.length).trim();
    idx = 1;
  }
  const chunks: V4AChunk[] = [];
  let cur: V4AChunk | null = null;
  let firstChunk = true;
  const lineNo = (k: number): number => hdrLine + 1 + k;
  for (let k = idx; k < raw.length; k++) {
    const l = raw[k]!;
    if (l === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${lineNo(k)}`);
      cur.eof = true;
      chunks.push(cur);
      cur = null;
      firstChunk = false;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur !== null) chunks.push(cur);
      const anchor = l.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, o: [], n: [], eof: false };
      firstChunk = false;
      continue;
    }
    if (l.startsWith('*** ')) throw new Exit2(`error: parse ${lineNo(k)}`);
    if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
      if (cur === null) {
        if (!firstChunk) throw new Exit2(`error: parse ${lineNo(k)}`);
        cur = { anchor: null, o: [], n: [], eof: false };
        firstChunk = false;
      }
      if (l === '' || l.startsWith(' ')) {
        const text = l === '' ? '' : l.slice(1);
        const oi = cur.o.length;
        cur.o.push(text);
        cur.n.push({ text, ctxO: oi });
      } else if (l.startsWith('-')) {
        cur.o.push(l.slice(1));
      } else {
        cur.n.push({ text: l.slice(1), ctxO: -1 });
      }
      continue;
    }
    throw new Exit2(`error: parse ${lineNo(k)}`);
  }
  if (cur !== null) chunks.push(cur);
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${hdrLine}`);
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const f = splitFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        let foundAt: number | null = null;
        const tiers = strict ? [0] : [0, 1, 2];
        for (const t of tiers) {
          const key = tierKey(ch.anchor, t);
          for (let k = cursor; k < f.lines.length; k++) {
            if (tierKey(f.lines[k]!, t) === key) {
              foundAt = k;
              break;
            }
          }
          if (foundAt !== null) break;
        }
        if (foundAt === null) throw new Fail('no-match', path);
        cursor = foundAt + 1;
      }
      if (ch.o.length === 0) {
        const insAt = ch.eof ? f.lines.length : cursor;
        const ins = ch.n.map((x) => x.text);
        f.lines.splice(insAt, 0, ...ins);
        cursor = insAt + ins.length;
      } else {
        let placed: { pos: number; tier: number } | null = null;
        const tiers = strict ? [0] : [0, 1, 2];
        for (const t of tiers) {
          const occ = findOccurrences(f.lines, ch.o, t).filter((p) => p >= cursor);
          if (ch.eof) {
            const lastPos = f.lines.length - ch.o.length;
            if (occ.includes(lastPos)) {
              placed = { pos: lastPos, tier: t };
              break;
            }
          } else if (occ.length > 0) {
            placed = { pos: occ[0]!, tier: t };
            break;
          }
        }
        if (placed === null) throw new Fail('no-match', path);
        const rep = buildReplacement(f.lines, ch.o, ch.n, placed.pos, placed.tier);
        f.lines.splice(placed.pos, ch.o.length, ...rep);
        cursor = placed.pos + rep.length;
      }
    }
    const result = joinFile(f);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, result);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, result);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice('*** Add File: '.length).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = line.slice('*** Delete File: '.length).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      path = line.slice('*** Update File: '.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const hdrLine = i + 1;
    const raw: string[] = [];
    let j = i + 1;
    while (j < last) {
      const l = lines[j]!;
      if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
      raw.push(l);
      j++;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
    if (kind === 'add') {
      edits.push(v4aAdd(path, raw, hdrLine));
    } else if (kind === 'delete') {
      for (let k = 0; k < raw.length; k++) {
        if (!blank(raw[k]!)) throw new Exit2(`error: parse ${hdrLine + 1 + k}`);
      }
      edits.push(v4aDelete(path));
    } else {
      edits.push(v4aUpdate(path, raw, hdrLine, strict));
    }
    i = j;
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json' ? jsonEdits(text, lines)
      : kind === 'unified' ? unifiedEdits(lines, strict)
      : kind === 'search-replace' ? searchReplaceEdits(lines, strict)
      : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = tree.moves.slice();
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = 0;
      tree.moves.push(...beforeMoves);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rPairs: [string, string][] = [];
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rPairs.push([oldP, newP]);
    }
  }
  const rOld = new Set(rPairs.map(([o]) => o));
  const rNew = new Set(rPairs.map(([, n]) => n));
  const rows: { key: string; line: string }[] = [];
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (was === null && rNew.has(p)) continue;
    if (now === null && rOld.has(p)) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const [o, n] of rPairs) rows.push({ key: n, line: `R ${o} -> ${n}` });
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outLines = rows.map((r) => r.line);
  if (!check) {
    // Write in byte order of the paths, as the starter did: a deletion of a path must land before a
    // creation under it, or mkdir fails on the file the patch deletes (SPEC.md section 10: when none
    // failed, every change is written).
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
