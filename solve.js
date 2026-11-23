// Fast drop-in for makefun-site 1.0.0 (make.fun's own static site generator).
//
// Original code, written from the behaviour stated in makefun-site's README and
// its reference implementation. It returns exactly the same output tree, byte for
// byte, for every input — same front matter rules, template dialect, Markdown
// subset, slug rule and report — while doing far less work:
//
//  - HTML escaping, slugifying, front-matter and Markdown scanning are hand
//    rolled char-by-char scanners (no per-line/per-character regexes);
//  - slug results are cached per case (titles, tags and headings repeat);
//  - inline Markdown flushes plain text in bulk instead of escaping one
//    character at a time;
//  - templates are compiled once per case into plain JavaScript functions
//    (with a tree-walking interpreter as a fallback if code generation is
//    unavailable), so rendering is straight-line code, not a node dispatch.
//
// run(input) answers one case alone; nothing is shared between cases.

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The top-level directories the generator writes itself. */
const RESERVED = ['posts', 'tags', 'page'];

/** The report file every build writes. */
const REPORT_FILE = 'build-report.txt';

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// ------------------------------------------------------------------ text

/** The HTML escape table: & < > " ' (same table as makefun-site). */
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;
const ESC_TEST = /[&<>"']/;
const escChar = (c) => ESCAPES[c];

/** `text` with & < > " and ' escaped. Most calls hold none of them. */
function escapeHtml(text) {
  if (!ESC_TEST.test(text)) return text;
  return text.replace(ESC_RE, escChar);
}

/** The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run of
 *  characters other than a-z and 0-9 one "-", none at either end, at most 64
 *  characters (a "-" left at the cut dropped), "untitled" when nothing is left. */
function slugifyRaw(text) {
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) >= 128) {
      ascii = false;
      break;
    }
  }
  // NFKD and the combining-mark strip are identities on pure ASCII.
  const plain = ascii ? text : text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    const c = ch.charCodeAt(0);
    let keep = null;
    if (c >= 65 && c <= 90) keep = ch.toLowerCase();
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, 64).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  const d = (date.charCodeAt(8) - 48) * 10 + (date.charCodeAt(9) - 48);
  const m = (date.charCodeAt(5) - 48) * 10 + (date.charCodeAt(6) - 48);
  return `${d} ${MONTHS[m - 1]} ${date.slice(0, 4)}`;
}

/** Whether code `c` is a JavaScript \s whitespace character. */
function isWSCode(c) {
  return (
    c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 0xa0 || c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f ||
    c === 0x3000 || c === 0xfeff
  );
}

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let inW = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c <= 32) {
      inW = false;
      continue;
    }
    if (inW) continue;
    if (c < 128 || !isWSCode(c)) {
      inW = true;
      n++;
    }
  }
  return n;
}

// ------------------------------------------------------------------ front matter

const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

function isLowerKeyChar(c) {
  return (c >= 97 && c <= 122) || c === 95; // a-z _
}

function isNameChar(c) {
  return (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45; // a-z 0-9 -
}

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    // '"'
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        if (i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        const n = raw[i + 1];
        if (n !== '"' && n !== '\\') return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' }; // '['
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
      let y = 0;
      let mo = 0;
      let d = 0;
      if (ok) {
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          const c = raw.charCodeAt(i);
          if (c < 48 || c > 57) {
            ok = false;
            break;
          }
        }
      }
      if (ok) {
        y = (raw.charCodeAt(0) - 48) * 1000 + (raw.charCodeAt(1) - 48) * 100 + (raw.charCodeAt(2) - 48) * 10 + (raw.charCodeAt(3) - 48);
        mo = (raw.charCodeAt(5) - 48) * 10 + (raw.charCodeAt(6) - 48);
        d = (raw.charCodeAt(8) - 48) * 10 + (raw.charCodeAt(9) - 48);
        if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) ok = false;
      }
      if (!ok) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',');
      for (let i = 0; i < tags.length; i++) {
        tags[i] = tags[i].trim();
        const t = tags[i];
        if (t === '' || t.indexOf('"') !== -1 || t.indexOf('[') !== -1 || t.indexOf(']') !== -1) {
          return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      if (raw.length === 0) return { error: 'key "layout": not a template name' };
      for (let i = 0; i < raw.length; i++) if (!isNameChar(raw.charCodeAt(i))) return { error: 'key "layout": not a template name' };
      return { value: raw };
    }
    case 'slug': {
      if (raw.length === 0 || raw.length > 64) return { error: 'key "slug": not a slug' };
      let prevDash = true; // a slug may not open on '-'
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (c === 45) {
          if (prevDash) return { error: 'key "slug": not a slug' };
          prevDash = true;
        } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) prevDash = false;
        else return { error: 'key "slug": not a slug' };
      }
      if (prevDash) return { error: 'key "slug": not a slug' };
      return { value: raw };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first
 * reason it is refused. `text` has "\n" line ends. The front matter region is
 * scanned by line starts (no whole-text split) and the body is a slice of the
 * text, never a rejoin.
 */
function parseFrontMatter(text) {
  let firstEnd = text.indexOf('\n');
  if (firstEnd === -1) firstEnd = text.length;
  if (firstEnd !== 3 || text.charCodeAt(0) !== 45 || text.charCodeAt(1) !== 45 || text.charCodeAt(2) !== 45) {
    return { error: 'no front matter' };
  }
  // The close: the first line exactly '---' after the opening one.
  let closeStart = -1;
  let closeEnd = -1;
  let pos = firstEnd + 1;
  while (pos <= text.length) {
    let nl = text.indexOf('\n', pos);
    if (nl === -1) nl = text.length;
    if (nl - pos === 3 && text.charCodeAt(pos) === 45 && text.charCodeAt(pos + 1) === 45 && text.charCodeAt(pos + 2) === 45) {
      closeStart = pos;
      closeEnd = nl;
      break;
    }
    if (nl === text.length) break;
    pos = nl + 1;
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  const fmText = text.slice(firstEnd + 1, closeStart);
  const lines = fmText === '' ? [] : fmText.split('\n');
  const data = {};
  for (let j = 0; j < lines.length; j++) {
    const line = lines[j];
    let blank = true;
    for (let k = 0; k < line.length; k++) {
      const c = line.charCodeAt(k);
      if (c !== 32 && c !== 9) {
        blank = false;
        break;
      }
    }
    if (blank || line.charCodeAt(0) === 35) continue; // '#' comment
    const colon = line.indexOf(':');
    if (colon <= 0) return { error: `line ${j + 2} is not "key: value"` };
    let keyOk = true;
    for (let k = 0; k < colon; k++) {
      if (!isLowerKeyChar(line.charCodeAt(k))) {
        keyOk = false;
        break;
      }
    }
    if (!keyOk) return { error: `line ${j + 2} is not "key: value"` };
    const key = line.slice(0, colon);
    const rest = line.slice(colon + 1);
    let raw;
    if (rest === '') raw = '';
    else if (rest.charCodeAt(0) === 32) raw = rest.slice(1);
    else return { error: `line ${j + 2} is not "key: value"` };
    let end = raw.length;
    while (end > 0) {
      const c = raw.charCodeAt(end - 1);
      if (c !== 32 && c !== 9) break;
      end--;
    }
    raw = raw.slice(0, end);
    if (!FM_KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: closeEnd === text.length ? '' : text.slice(closeEnd + 1) };
}

// ------------------------------------------------------------------ Markdown

/** The characters a backslash escapes. */
const ESCAPABLE = '\\`*_[]()#+-.!>';

function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return line.slice(a, b);
}

function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function isLangChar(c) {
  return (
    (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45
  );
}

/** A fence-open line's language, or null. */
function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let j = 3;
  while (j < line.length && isLangChar(line.charCodeAt(j))) j++;
  const lang = line.slice(3, j);
  while (j < line.length && (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9)) j++;
  return j === line.length ? lang : null;
}

function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let j = 3; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null. */
function headingOf(line) {
  let c = 0;
  while (c < line.length && line.charCodeAt(c) === 35) c++;
  if (c < 1 || c > 6 || c >= line.length) return null;
  const s = line.charCodeAt(c);
  if (s !== 32 && s !== 9) return null;
  let a = c;
  while (a < line.length && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  let b = line.length;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  if (b === a) return null;
  return { depth: c, text: line.slice(a, b) };
}

function isHr(line) {
  if (line !== '---' && line !== '***') {
    if (!line.startsWith('---') && !line.startsWith('***')) return false;
  }
  const head = line.startsWith('---') ? 3 : line.startsWith('***') ? 3 : -1;
  if (head === -1) return false;
  for (let j = head; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A bullet line's item text, or null. */
function bulletMatch(line) {
  const c = line.charCodeAt(0);
  if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

/** An ordered-list line: { num, text }, or null. */
function orderedMatch(line) {
  let j = 0;
  while (j < line.length && line.charCodeAt(j) >= 48 && line.charCodeAt(j) <= 57) j++;
  if (j < 1 || j > 9) return null;
  if (line.charCodeAt(j) !== 46 || line.charCodeAt(j + 1) !== 32) return null;
  return { num: Number(line.slice(0, j)), text: line.slice(j + 2) };
}

/** A list continuation line: two or more spaces, then a non-space. */
function isContinued(line) {
  let k = 0;
  while (k < line.length && line.charCodeAt(k) === 32) k++;
  return k >= 2 && k < line.length && !isWSCode(line.charCodeAt(k));
}

/** Whether `line` ends a paragraph. */
function endsParagraph(line) {
  return isBlank(line) || fenceOpen(line) !== null || headingOf(line) !== null || isHr(line);
}

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  const wlen = what.length;
  for (let j = from; j <= s.length - wlen; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < s.length && ESCAPABLE.indexOf(s[j + 1]) !== -1) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < s.length && ESCAPABLE.indexOf(s[j + 1]) !== -1) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** The characters that can start an inline construct: \ ` * [ */
const INLINE_SPECIAL = /[\\`*[]/g;

/**
 * `s` rendered inline; `env.link(target)` is a link's href. Plain runs between
 * constructs are found with one native search and escaped in bulk.
 */
function inline(s, env) {
  let out = '';
  let i = 0; // start of the unflushed plain run
  let p = 0; // scan position
  const n = s.length;
  while (p < n) {
    INLINE_SPECIAL.lastIndex = p;
    const m = INLINE_SPECIAL.exec(s);
    if (m === null) break;
    const j = m.index;
    const c = s.charCodeAt(j);
    if (c === 92) {
      // backslash
      if (j + 1 < n && ESCAPABLE.indexOf(s[j + 1]) !== -1) {
        if (j > i) out += escapeHtml(s.slice(i, j));
        out += s[j + 1] === '>' ? '&gt;' : s[j + 1];
        p = j + 2;
        i = p;
      } else p = j + 1; // not an escape: the backslash stays in the plain run
      continue;
    }
    if (j > i) out += escapeHtml(s.slice(i, j));
    if (c === 96) {
      // backtick
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        out += `<code>${escapeHtml(s.slice(j + 1, k))}</code>`;
        p = k + 1;
      } else {
        out += '`';
        p = j + 1;
      }
      i = p;
      continue;
    }
    if (c === 42) {
      // *
      if (s.charCodeAt(j + 1) === 42) {
        const k = findUnescaped(s, '**', j + 2);
        if (k > j + 2) {
          out += `<strong>${inline(s.slice(j + 2, k), env)}</strong>`;
          p = k + 2;
        } else {
          out += '**';
          p = j + 2;
        }
      } else {
        const k = findSingleStar(s, j + 1);
        if (k > j + 1) {
          out += `<em>${inline(s.slice(j + 1, k), env)}</em>`;
          p = k + 1;
        } else {
          out += '*';
          p = j + 1;
        }
      }
      i = p;
      continue;
    }
    // '['
    const k = findUnescaped(s, ']', j + 1);
    const q = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
    const target = q === -1 ? '' : s.slice(k + 2, q);
    let hasWs = false;
    for (let t = 0; t < target.length; t++) {
      if (isWSCode(target.charCodeAt(t))) {
        hasWs = true;
        break;
      }
    }
    if (target !== '' && !hasWs) {
      out += `<a href="${escapeHtml(env.link(target))}">${inline(s.slice(j + 1, k), env)}</a>`;
      p = q + 1;
    } else {
      out += '[';
      p = j + 1;
    }
    i = p;
  }
  if (n > i) out += escapeHtml(s.slice(i));
  return out;
}

/**
 * `src` rendered: its HTML, its table of contents (every level 2 and 3 heading)
 * and its excerpt (the first paragraph's inline HTML, or "").
 * `slugify` is the case's cached slug function.
 */
function renderMarkdown(src, env, slugify) {
  const lines = src.split('\n');
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const lang = fenceOpen(line);
    if (lang !== null) {
      i++;
      let html = '<pre><code' + (lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`) + '>';
      while (i < n && !isFenceClose(lines[i])) {
        html += escapeHtml(lines[i]) + '\n';
        i++;
      }
      i++;
      html += '</code></pre>';
      blocks.push(html);
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text), ids);
      const html = inline(heading.text, env);
      blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if (isHr(line)) {
      blocks.push('<hr>');
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      // '>'
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const l = lines[i];
        body.push(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
        i++;
      }
      const kept = [];
      for (const l of body) {
        const t = trimLine(l);
        if (t !== '') kept.push(t);
      }
      blocks.push(kept.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(kept.join('\n'), env)}</p>\n</blockquote>`);
      continue;
    }
    const bullet = bulletMatch(line);
    const ordered = bullet === null ? orderedMatch(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const items = [[trimLine(isOrdered ? ordered.text : bullet)]];
      const start = isOrdered ? ordered.num : 1;
      i++;
      while (i < n) {
        const m = isOrdered ? orderedMatch(lines[i]) : bulletMatch(lines[i]);
        if (m !== null) {
          items.push([trimLine(isOrdered ? m.text : m)]);
          i++;
        } else if (isContinued(lines[i])) {
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
      let html = open + '\n';
      for (const parts of items) html += `<li>${inline(parts.join('\n'), env)}</li>\n`;
      html += `</${tag}>`;
      blocks.push(html);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) {
      body.push(trimLine(lines[i]));
      i++;
    }
    const html = inline(body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  return { html: blocks.length === 0 ? '' : `${blocks.join('\n')}\n`, toc, excerpt: excerpt ?? '' };
}

// ------------------------------------------------------------------ templates

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone =
      /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** Tree-walking renderer (fallback when a template cannot be compiled). */
function renderNodes(nodes, scope, templates, depth) {
  let out = '';
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out += n.text;
        break;
      case 'var':
        out += escapeHtml(textOf(lookup(scope, n.path)));
        break;
      case 'raw':
        out += textOf(lookup(scope, n.path));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) out += renderNodes(branch, scope, templates, depth);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        xs.forEach((x, k) => {
          const vars = { [n.name]: x, loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } };
          out += renderNodes(n.body, { vars, parent: scope }, templates, depth);
        });
        break;
      }
      case 'include': {
        const t = templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) out += renderNodes(t, scope, templates, depth + 1);
        break;
      }
    }
  }
  return out;
}

/**
 * Compile a parsed template into a function (S, T, N, D, W, ...) => string: S the
 * scope chain, T the map of compiled templates, N the map of parsed templates,
 * D the include depth, W the tree-walking renderer (fallback). Falls back to
 * the tree walker when code generation is unavailable.
 */
function compileTemplate(nodes) {
  let src = 'let o="";\n';
  // One scope frame per for-node, declared up front and reused by every
  // iteration of that loop within one render (no allocation per iteration).
  // The frame's `loop` object is likewise written in place each iteration.
  let counter = 0;
  const frames = [];
  const collect = (list) => {
    for (const n of list) {
      if (n.kind === 'for') {
        counter++;
        n._frame = counter;
        frames.push(n);
        collect(n.body);
      } else if (n.kind === 'if') {
        collect(n.then);
        if (n.else !== null) collect(n.else);
      }
    }
  };
  collect(nodes);
  for (const f of frames) {
    src += `const s${f._frame}={vars:{},parent:null};\n`;
    if (f.name !== 'loop') src += `const l${f._frame}={};s${f._frame}.vars.loop=l${f._frame};\n`;
  }
  const gen = (list, scopeVar) => {
    for (const n of list) {
      if (n.kind === 'text') src += `o+=${JSON.stringify(n.text)};\n`;
      else if (n.kind === 'var') src += `o+=E(X(L(${scopeVar},${JSON.stringify(n.path)})));\n`;
      else if (n.kind === 'raw') src += `o+=X(L(${scopeVar},${JSON.stringify(n.path)}));\n`;
      else if (n.kind === 'if') {
        src += `if(TY(L(${scopeVar},${JSON.stringify(n.path)}))===${n.not ? 'false' : 'true'}){\n`;
        gen(n.then, scopeVar);
        src += '}';
        if (n.else !== null) {
          src += 'else{\n';
          gen(n.else, scopeVar);
          src += '}';
        }
        src += '\n';
      } else if (n.kind === 'for') {
        const id = n._frame;
        const sv = `s${id}`;
        const kv = `k${id}`;
        const nv = `n${id}`;
        const av = `a${id}`;
        src += `{const ${av}=L(${scopeVar},${JSON.stringify(n.path)});if(Array.isArray(${av})){for(let ${kv}=0,${nv}=${av}.length;${kv}<${nv};${kv}++){${sv}.vars[${JSON.stringify(n.name)}]=${av}[${kv}];`;
        if (n.name !== 'loop') src += `l${id}.index=${kv}+1;l${id}.first=${kv}===0;l${id}.last=${kv}===${nv}-1;l${id}.length=${nv};`;
        src += `${sv}.parent=${scopeVar};\n`;
        gen(n.body, sv);
        src += '}}}\n';
      } else if (n.kind === 'include') {
        src += `if(D<8){const _f=T.get(${JSON.stringify(n.name)});if(_f!==undefined)o+=_f(${scopeVar},T,N,D+1,W,L,E,X,TY);else{const _n=N.get(${JSON.stringify(n.name)});if(_n!==undefined)o+=W(_n,${scopeVar},N,D+1);}}\n`;
      }
    }
  };
  gen(nodes, 'S');
  src += 'return o;';
  try {
    // S scope chain, T compiled templates, N parsed templates, D include depth,
    // W tree-walking renderer (fallback), L lookup, E escape, X textOf, TY truthy.
    return new Function('S', 'T', 'N', 'D', 'W', 'L', 'E', 'X', 'TY', src);
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ the build

/** `rel` from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** A page's link record as templates read it. */
const linkOf = (s) =>
  s === null
    ? null
    : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) };

/** One site's output tree: path -> text. */
export function run(input) {
  // Per-case slug cache: titles, tags and headings repeat within a site.
  const slugCache = new Map();
  const slugify = (text) => {
    let r = slugCache.get(text);
    if (r === undefined) {
      r = slugifyRaw(text);
      slugCache.set(text, r);
    }
    return r;
  };

  const templates = new Map(); // name -> parsed nodes
  const compiled = new Map(); // name -> compiled function
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      const nodes = parseTemplate(name, input.templates[name]);
      templates.set(name, nodes);
      const fn = compileTemplate(nodes);
      if (fn !== null) compiled.set(name, fn);
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }

  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. The sources, in code-unit order of their paths; a source that is not .md is static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  let sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const text = f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content;
      sources.push({ path: f.path, text });
    } else statics.push({ path: f.path, content: f.content });
  }

  // 2. Each source's front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  sources = kept;

  // 3. Each page's output directory and url: its slug made unique in its directory, in source order.
  const taken = new Map();
  const takenIn = (dir) => {
    if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
    return taken.get(dir);
  };
  const bySource = new Map();
  for (const s of sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of sources) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env, slugify);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.readingMinutes = Math.max(1, Math.ceil(wordsOf(s.body) / 200));
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    return (s.data.tags ?? []).filter((name) => !seen.has(slugify(name)) && seen.add(slugify(name)));
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${base}/tags/${slug}/`, posts: [] });
      const tag = bySlug.get(slug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of sources) {
    if (!s.post) s.tagRefs = ownTags(s).map((name) => bySlug.get(slugify(name)) ?? { name, slug: slugify(name), url: '', posts: [] });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  /** A post's card, as lists show it. */
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: s.readingMinutes,
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  /** A page as its layout reads it. */
  const pageOf = (s) => ({
    ...cardOf(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });
  /** A tag as templates read it (its posts as cards). */
  const tagOf = (t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) });

  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const output = {};

  const render = (name, vars) => {
    const fn = compiled.get(name);
    const scope = { vars: { site, tags: allTags, recent, ...vars }, parent: null };
    if (fn !== undefined) return fn(scope, compiled, templates, 0, renderNodes, lookup, escapeHtml, textOf, truthy);
    const nodes = templates.get(name);
    return nodes === undefined ? null : renderNodes(nodes, scope, templates, 0);
  };

  for (const s of sources) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: tagOf(t) });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = sources.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;

  return output;
}
