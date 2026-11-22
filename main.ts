// main.ts is mend, the CLI SPEC.md specifies (MIT). It reads an edit an AI model wrote, in one of four formats
// (unified diff, SEARCH/REPLACE blocks, the V4A patch format, or JSON text-editor calls), and applies it to the
// tree in the working directory: every file is changed or nothing is. Sections 1 to 4, 9 and 10 are the command
// line, the output and exit codes, safe paths, format detection, JSON edits and the all-or-nothing write;
// sections 5 to 8 are the three-tier line matching and the unified, SEARCH/REPLACE and V4A readers. Node 22, the
// standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to
// runner.ts (the last lines below): keep that hand-over and runner.ts as they are.

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
  readonly moves: { from: string; to: string }[] = [];
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

/** A file's lines, its own line break, and whether it ends with one (SPEC.md section 3). */
interface FileState {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const final = text.endsWith(br);
  const lines = text.split(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function joinFile(st: FileState): string {
  return st.lines.length === 0 ? '' : st.lines.join(st.br) + (st.final ? st.br : '');
}

/** One line of N: its text, and for a context line the index of the line of O it is (else -1). */
interface NLine {
  text: string;
  ctx: number;
}

const NORMS: ((l: string) => string)[] = [
  (l) => l,
  (l) => l.replace(/[ \t]+$/, ''),
  (l) => l.replace(/^[ \t]+/, '').replace(/[ \t]+$/, ''),
];

/** The first tier at which O occurs in lines, with every occurrence position there (SPEC.md section 5). */
function findTier(lines: string[], o: string[], strict: boolean): { tier: number; occ: number[] } | null {
  for (const t of strict ? [0] : [0, 1, 2]) {
    const norm = NORMS[t]!;
    const on = o.map(norm);
    const occ: number[] = [];
    for (let i = 0; i + o.length <= lines.length; i += 1) {
      let ok = true;
      for (let j = 0; j < o.length; j += 1) {
        if (norm(lines[i + j]!) !== on[j]) {
          ok = false;
          break;
        }
      }
      if (ok) occ.push(i);
    }
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

function leadWS(l: string): string {
  const m = /^[ \t]*/.exec(l);
  return m === null ? '' : m[0];
}

/** What N becomes at a match: context lines are the file's own lines; at tier 2 the rest are re-indented. */
function buildNew(n: NLine[], o: string[], fileLines: string[], at: number, tier: number): string[] {
  const f = leadWS(fileLines[at]!);
  const p = leadWS(o[0]!);
  return n.map((e) => {
    if (e.ctx >= 0) return fileLines[at + e.ctx]!;
    if (tier === 2 && e.text !== '' && !/^[ \t]*$/.test(e.text) && e.text.startsWith(p)) return f + e.text.slice(p.length);
    return e.text;
  });
}

/** The O and N of a hunk or chunk body: context and `-` lines are O, context and `+` lines are N, in body order. */
function bodyON(body: string[]): { o: string[]; n: NLine[] } {
  const o: string[] = [];
  const n: NLine[] = [];
  for (const l of body) {
    if (l === '' || l[0] === ' ') {
      const t = l === '' ? '' : l.slice(1);
      o.push(t);
      n.push({ text: t, ctx: o.length - 1 });
    } else if (l[0] === '-') o.push(l.slice(1));
    else if (l[0] === '+') n.push({ text: l.slice(1), ctx: -1 });
  }
  return { o, n };
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

/** One unified hunk: its A, its O and N, and whether a `\` line takes the result's final break away. */
interface Hunk {
  a: number;
  o: string[];
  n: NLine[];
  noNL: boolean;
  plusNoNL: boolean;
}

function makeHunk(a: number, body: string[]): Hunk {
  const { o, n } = bodyON(body.filter((l) => !l.startsWith('\\')));
  let lastCtxPlus = -1;
  let lastPlus = -1;
  body.forEach((l, idx) => {
    if (l === '' || l[0] === ' ' || l[0] === '+') lastCtxPlus = idx;
    if (l[0] === '+') lastPlus = idx;
  });
  return {
    a,
    o,
    n,
    noNL: lastCtxPlus >= 0 && (body[lastCtxPlus + 1] ?? '').startsWith('\\'),
    plusNoNL: lastPlus >= 0 && (body[lastPlus + 1] ?? '').startsWith('\\'),
  };
}

/** Apply a section's hunks in order to a file state; d is the running line drift of the section. */
function applyHunks(st: FileState, hunks: Hunk[], strict: boolean, path: string): void {
  let d = 0;
  for (const h of hunks) {
    if (h.o.length === 0) {
      let p = h.a + d;
      if (p < 0) p = 0;
      if (p > st.lines.length) p = st.lines.length;
      const atEnd = p === st.lines.length;
      st.lines.splice(p, 0, ...h.n.map((x) => x.text));
      if (atEnd) st.final = !h.noNL;
    } else {
      const f = findTier(st.lines, h.o, strict);
      if (f === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = f.occ[0]!;
      for (const i of f.occ) if (Math.abs(i - target) < Math.abs(best - target)) best = i;
      const built = buildNew(h.n, h.o, st.lines, best, f.tier);
      const toEnd = best + h.o.length === st.lines.length;
      st.lines.splice(best, h.o.length, ...built);
      if (toEnd) st.final = !h.noNL;
    }
    d += h.n.length - h.o.length;
  }
}

interface Section {
  gitOld: string | undefined;
  gitNew: string | undefined;
  hdrOld: string | null | undefined;
  hdrNew: string | null | undefined;
  pairSeen: boolean;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  newFile: boolean;
  delFile: boolean;
  hunks: Hunk[];
}

/** The path a `--- ` or `+++ ` line names: after the four characters, to the first tab, spaces removed. */
function headerPath(line: string): string | null {
  const raw = line.slice(4);
  const tab = raw.indexOf('\t');
  const p = (tab >= 0 ? raw.slice(0, tab) : raw).trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

function sectionEdit(s: Section, strict: boolean): Edit {
  const oldP = s.hdrOld !== undefined ? s.hdrOld : s.renameFrom !== undefined ? s.renameFrom : s.gitOld;
  const newP = s.hdrNew !== undefined ? s.hdrNew : s.renameTo !== undefined ? s.renameTo : s.gitNew;
  const oldS = typeof oldP === 'string' ? oldP : null;
  const newS = typeof newP === 'string' ? newP : null;
  if ((oldP === null || s.newFile) && newS !== null) {
    const target = newS;
    const plus: string[] = [];
    let final = true;
    for (const h of s.hunks) for (const e of h.n) if (e.ctx < 0) plus.push(e.text);
    for (const h of s.hunks) if (h.n.some((e) => e.ctx < 0)) final = !h.plusNoNL;
    return (tree) => {
      if (!safe(target)) throw new Fail('unsafe', target);
      if (tree.get(target) !== null) throw new Fail('exists', target);
      tree.now.set(target, plus.length === 0 ? '' : plus.join('\n') + (final ? '\n' : ''));
    };
  }
  if ((newP === null || s.delFile) && oldS !== null) {
    const source = oldS;
    return (tree) => {
      if (!safe(source)) throw new Fail('unsafe', source);
      if (tree.get(source) === null) throw new Fail('missing', source);
      tree.now.set(source, null);
    };
  }
  if (oldS !== null && newS !== null && oldS !== newS) {
    return (tree) => {
      if (!safe(oldS)) throw new Fail('unsafe', oldS);
      if (!safe(newS)) throw new Fail('unsafe', newS);
      const before = tree.get(oldS);
      if (before === null) throw new Fail('missing', oldS);
      if (tree.get(newS) !== null) throw new Fail('exists', newS);
      const st = splitFile(before);
      applyHunks(st, s.hunks, strict, oldS);
      tree.now.set(newS, joinFile(st));
      tree.now.set(oldS, null);
      tree.moves.push({ from: oldS, to: newS });
    };
  }
  const path = oldS ?? newS;
  if (path === null) return () => {};
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const st = splitFile(before);
    applyHunks(st, s.hunks, strict, path);
    tree.now.set(path, joinFile(st));
  };
}

/** Unified diffs (SPEC.md section 6): sections, their headers, and their hunks. */
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  const fresh = (): Section => ({
    gitOld: undefined,
    gitNew: undefined,
    hdrOld: undefined,
    hdrNew: undefined,
    pairSeen: false,
    renameFrom: undefined,
    renameTo: undefined,
    newFile: false,
    delFile: false,
    hunks: [],
  });
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = fresh();
      cur.gitOld = m[1]!;
      cur.gitNew = m[2]!;
      sections.push(cur);
      i += 1;
      continue;
    }
    if (line.startsWith('--- ')) {
      const next = lines[i + 1];
      if (next !== undefined && next.startsWith('+++ ')) {
        if (cur !== null && cur.hunks.length === 0 && !cur.pairSeen) {
          cur.hdrOld = headerPath(line);
          cur.hdrNew = headerPath(next);
          cur.pairSeen = true;
        } else {
          cur = fresh();
          cur.hdrOld = headerPath(line);
          cur.hdrNew = headerPath(next);
          cur.pairSeen = true;
          sections.push(cur);
        }
        i += 2;
        continue;
      }
      if (cur !== null && cur.hunks.length === 0) throw new Exit2(`error: parse ${i + 2}`);
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const l = lines[j]!;
        if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
          body.push(l);
          j += 1;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      cur.hunks.push(makeHunk(Number(m[1]), body));
      i = j;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('+++ ')) {
        cur.hdrNew = headerPath(line);
        i += 1;
        continue;
      }
      if (line.startsWith('rename from ')) {
        cur.renameFrom = line.slice(12).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renameTo = line.slice(10).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.newFile = true;
        i += 1;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.delFile = true;
        i += 1;
        continue;
      }
    }
    i += 1;
  }
  return sections.map((s) => sectionEdit(s, strict));
}

/** SEARCH/REPLACE blocks (SPEC.md section 7). */
function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = -1;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const s = i;
    let sep = -1;
    for (let j = s + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        sep = j;
        break;
      }
    }
    let end = -1;
    if (sep >= 0) {
      for (let j = sep + 1; j < lines.length; j += 1) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          end = j;
          break;
        }
      }
    }
    if (sep < 0 || end < 0) throw new Exit2(`error: parse ${s + 1}`);
    let path: string | null = null;
    for (let j = s - 1; j > prevEnd; j -= 1) {
      const l = lines[j]!;
      if (blank(l) || l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    const o = lines.slice(s + 1, sep);
    const n = lines.slice(sep + 1, end);
    const blockPath = path;
    edits.push((tree) => {
      if (!safe(blockPath)) throw new Fail('unsafe', blockPath);
      if (o.length === 0) {
        if (tree.get(blockPath) !== null) throw new Fail('exists', blockPath);
        tree.now.set(blockPath, n.length === 0 ? '' : n.join('\n') + '\n');
        return;
      }
      const before = tree.get(blockPath);
      if (before === null) throw new Fail('missing', blockPath);
      const st = splitFile(before);
      const f = findTier(st.lines, o, strict);
      if (f === null) throw new Fail('no-match', blockPath);
      if (f.occ.length > 1) throw new Fail('ambiguous', blockPath);
      const built = buildNew(
        n.map((t) => ({ text: t, ctx: -1 })),
        o,
        st.lines,
        f.occ[0]!,
        f.tier,
      );
      st.lines.splice(f.occ[0]!, o.length, ...built);
      tree.now.set(blockPath, joinFile(st));
    });
    prevPath = path;
    prevEnd = end;
    i = end + 1;
  }
  return edits;
}

interface Chunk {
  anchor: string | null;
  o: string[];
  n: NLine[];
  eof: boolean;
}

/** The first line at or after the cursor equal to the anchor, at the first tier that has one. */
function findAnchor(lines: string[], cursor: number, anchor: string, strict: boolean): number {
  for (const t of strict ? [0] : [0, 1, 2]) {
    const norm = NORMS[t]!;
    const want = norm(anchor);
    for (let i = cursor; i < lines.length; i += 1) if (norm(lines[i]!) === want) return i;
  }
  return -1;
}

/** The first occurrence of O at or after the cursor, at the first tier that has one there. */
function findChunk(lines: string[], o: string[], cursor: number, eof: boolean, strict: boolean): { at: number; tier: number } | null {
  for (const t of strict ? [0] : [0, 1, 2]) {
    const norm = NORMS[t]!;
    const on = o.map(norm);
    for (let i = cursor; i + o.length <= lines.length; i += 1) {
      if (eof && i + o.length !== lines.length) continue;
      let ok = true;
      for (let j = 0; j < o.length; j += 1) {
        if (norm(lines[i + j]!) !== on[j]) {
          ok = false;
          break;
        }
      }
      if (ok) return { at: i, tier: t };
    }
  }
  return null;
}

interface VSection {
  kind: 'add' | 'del' | 'upd';
  path: string;
  line: number;
  raw: { text: string; no: number }[];
}

function vSectionEdit(s: VSection, strict: boolean): Edit {
  const raw = [...s.raw];
  while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
  if (s.kind === 'add') {
    const content: string[] = [];
    for (const r of raw) {
      if (r.text.startsWith('+')) content.push(r.text.slice(1));
      else if (r.text === '') content.push('');
      else throw new Exit2(`error: parse ${r.no}`);
    }
    return (tree) => {
      if (!safe(s.path)) throw new Fail('unsafe', s.path);
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      tree.now.set(s.path, content.length === 0 ? '' : content.join('\n') + '\n');
    };
  }
  if (s.kind === 'del') {
    if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.no}`);
    return (tree) => {
      if (!safe(s.path)) throw new Fail('unsafe', s.path);
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.now.set(s.path, null);
    };
  }
  let moveTo: string | null = null;
  let idx = 0;
  if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to: ')) {
    moveTo = raw[0]!.text.slice('*** Move to: '.length).trim();
    idx = 1;
  }
  const chunks: Chunk[] = [];
  let open: { anchor: string | null; body: string[]; eof: boolean } | null = null;
  let closed = false;
  for (; idx < raw.length; idx += 1) {
    const r = raw[idx]!;
    const l = r.text;
    if (l.startsWith('@@')) {
      const a = l.slice(2).trim();
      open = { anchor: a === '' ? null : a, body: [], eof: false };
      chunks.push(open as Chunk & { body: string[] });
      closed = false;
    } else if (l === '*** End of File') {
      if (open === null || closed) throw new Exit2(`error: parse ${r.no}`);
      open.eof = true;
      closed = true;
      open = null;
    } else if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
      if (open === null) {
        if (chunks.length > 0 || closed) throw new Exit2(`error: parse ${r.no}`);
        open = { anchor: null, body: [], eof: false };
        chunks.push(open as Chunk & { body: string[] });
      }
      open.body.push(l);
    } else throw new Exit2(`error: parse ${r.no}`);
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${s.line}`);
  const parsed: Chunk[] = chunks.map((c) => {
    const { o, n } = bodyON((c as unknown as { body: string[] }).body);
    return { anchor: c.anchor, o, n, eof: c.eof };
  });
  const from = s.path;
  const to = moveTo;
  return (tree) => {
    if (!safe(from)) throw new Fail('unsafe', from);
    if (to !== null && !safe(to)) throw new Fail('unsafe', to);
    const before = tree.get(from);
    if (before === null) throw new Fail('missing', from);
    if (to !== null && tree.get(to) !== null) throw new Fail('exists', to);
    const st = splitFile(before);
    let cursor = 0;
    for (const ch of parsed) {
      if (ch.anchor !== null) {
        const at = findAnchor(st.lines, cursor, ch.anchor, strict);
        if (at < 0) throw new Fail('no-match', from);
        cursor = at + 1;
      }
      if (ch.o.length === 0) {
        const p = ch.eof ? st.lines.length : cursor;
        st.lines.splice(p, 0, ...ch.n.map((x) => x.text));
        cursor = p + ch.n.length;
      } else {
        const f = findChunk(st.lines, ch.o, cursor, ch.eof, strict);
        if (f === null) throw new Fail('no-match', from);
        const built = buildNew(ch.n, ch.o, st.lines, f.at, f.tier);
        st.lines.splice(f.at, ch.o.length, ...built);
        cursor = f.at + built.length;
      }
    }
    if (to !== null) {
      tree.now.set(to, joinFile(st));
      tree.now.set(from, null);
      tree.moves.push({ from, to });
    } else tree.now.set(from, joinFile(st));
  };
}

/** V4A patches (SPEC.md section 8). */
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let cur: VSection | null = null;
  for (let i = first + 1; i < last; i += 1) {
    const l = lines[i]!;
    const kind = l.startsWith('*** Add File: ')
      ? 'add'
      : l.startsWith('*** Delete File: ')
        ? 'del'
        : l.startsWith('*** Update File: ')
          ? 'upd'
          : null;
    if (kind !== null) {
      const prefix = kind === 'add' ? '*** Add File: ' : kind === 'del' ? '*** Delete File: ' : '*** Update File: ';
      cur = { kind, path: l.slice(prefix.length).trim(), line: i + 1, raw: [] };
      sections.push(cur);
    } else if (cur === null) {
      if (!blank(l)) throw new Exit2(`error: parse ${i + 1}`);
    } else cur.raw.push({ text: l, no: i + 1 });
  }
  return sections.map((s) => vSectionEdit(s, strict));
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
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
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
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; text: string }[] = [];
  const consumed = new Set<string>();
  for (const mv of tree.moves) {
    if (consumed.has(mv.from) || consumed.has(mv.to)) continue;
    const wasFrom = tree.original(mv.from);
    const nowFrom = tree.now.get(mv.from) ?? null;
    const wasTo = tree.original(mv.to);
    const nowTo = tree.now.get(mv.to) ?? null;
    if (wasFrom !== null && nowFrom === null && wasTo === null && nowTo !== null) {
      rows.push({ key: mv.to, text: `R ${mv.from} -> ${mv.to}` });
      consumed.add(mv.from);
      consumed.add(mv.to);
    }
  }
  for (const p of tree.now.keys()) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const [p, now] of tree.now) {
      const was = tree.original(p);
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
