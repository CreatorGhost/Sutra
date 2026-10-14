// Markdown for AI answers: headings, paragraphs (line breaks kept, as in chat), bullet and numbered
// lists (nested by indent), quotes, fenced code, simple tables, rules, and inline **bold**, *italic*,
// `code`, ~~strike~~ and links. Built as React elements — never HTML — so nothing in an answer can
// inject markup or script. Links open only for http(s)/mailto. Inline code that looks like a file path
// can be made clickable (`onPath`), e.g. to show it in Finder.
import { Fragment, type ReactNode } from "react";

type Block =
  | { t: "h"; level: number; text: string }
  | { t: "p"; lines: string[] }
  | { t: "code"; lang: string; text: string }
  | { t: "quote"; lines: string[] }
  | { t: "list"; ordered: boolean; start: number; items: { text: string; children: Block[] }[] }
  | { t: "table"; head: string[]; rows: string[][] }
  | { t: "hr" };

const LIST = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;
const indentOf = (s: string) => s.replace(/\t/g, "  ").match(/^ */)![0].length;
const splitRow = (s: string) => s.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());

/** Block structure of a Markdown string. Exported for tests. */
export function parseBlocks(src: string): Block[] {
  const lines = String(src ?? "").replace(/\r\n?/g, "\n").split("\n");
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const fence = /^\s*(```|~~~)\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]);
      i++;
      out.push({ t: "code", lang: fence[2], text: body.join("\n") });
      continue;
    }
    const h = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) { out.push({ t: "h", level: h[1].length, text: h[2] }); i++; continue; }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push({ t: "hr" }); i++; continue; }
    if (/^\s*>/.test(line)) {
      const q: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ""));
      out.push({ t: "quote", lines: q });
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
      const head = splitRow(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(splitRow(lines[i++]));
      out.push({ t: "table", head, rows });
      continue;
    }
    if (LIST.test(line)) {
      const [block, next] = parseList(lines, i, indentOf(line));
      out.push(block);
      i = next;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !LIST.test(lines[i]) && !/^\s*(```|~~~|#{1,6}\s|>)/.test(lines[i])) para.push(lines[i++].trim());
    out.push({ t: "p", lines: para });
  }
  return out;
}

function parseList(lines: string[], start: number, indent: number): [Block & { t: "list" }, number] {
  const first = LIST.exec(lines[start])!;
  const ordered = /\d/.test(first[2]);
  const block: Block & { t: "list" } = { t: "list", ordered, start: ordered ? parseInt(first[2], 10) || 1 : 1, items: [] };
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      // A blank line ends the list unless the next line continues it.
      const nextLine = lines[i + 1];
      if (nextLine && LIST.test(nextLine) && indentOf(nextLine) >= indent) { i++; continue; }
      break;
    }
    const m = LIST.exec(line);
    const ind = indentOf(line);
    if (m && ind === indent || (m && ind < indent + 2 && ind >= indent)) {
      if (/\d/.test(m![2]) !== ordered && ind === indent && block.items.length) break;
      block.items.push({ text: m![3], children: [] });
      i++;
    } else if (m && ind > indent) {
      const [child, next] = parseList(lines, i, ind);
      block.items.at(-1)?.children.push(child);
      i = next;
    } else if (!m && ind > indent && block.items.length) {
      block.items.at(-1)!.text += "\n" + line.trim(); // a wrapped item
      i++;
    } else break;
  }
  return [block, i];
}

const SAFE_URL = /^(https?:\/\/|mailto:)/i;
/** A file path (it has an extension), optionally with a line: "src/x.ts", "a/b/values.yaml.gotmpl:29". */
const PATHLIKE = /^(?:\.{0,2}\/)?(?:[\w@.+-]+\/)*[\w@+-][\w@.+-]*\.[A-Za-z][\w]{0,9}(?::\d+(?:-\d+)?)?$/;

/** Inline Markdown → React nodes. */
export function inline(text: string, onPath?: (path: string) => void, key = "i"): ReactNode[] {
  const out: ReactNode[] = [];
  let rest = text;
  let n = 0;
  const push = (node: ReactNode) => out.push(<Fragment key={`${key}${n++}`}>{node}</Fragment>);
  const RE = /(`+)([\s\S]+?)\1|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|~~([\s\S]+?)~~|\*(?!\s)([^*\n]+?)\*|(?<![\w])_(?!\s)([^_\n]+?)_(?![\w])|\[([^\]\n]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/;
  while (rest) {
    const m = RE.exec(rest);
    if (!m) { push(rest); break; }
    if (m.index) push(rest.slice(0, m.index));
    if (m[2] != null) {
      const code = m[2].trim();
      push(onPath && PATHLIKE.test(code)
        ? <button type="button" className="md-path" title="Show in Finder" onClick={() => onPath(code)}>{code}</button>
        : <code>{code}</code>);
    } else if (m[3] != null || m[4] != null) push(<strong>{inline(m[3] ?? m[4], onPath, `${key}${n}b`)}</strong>);
    else if (m[5] != null) push(<del>{inline(m[5], onPath, `${key}${n}s`)}</del>);
    else if (m[6] != null || m[7] != null) push(<em>{inline(m[6] ?? m[7], onPath, `${key}${n}e`)}</em>);
    else if (m[8] != null) {
      const href = m[9];
      push(SAFE_URL.test(href) ? <a href={href} target="_blank" rel="noreferrer noopener">{inline(m[8], onPath, `${key}${n}a`)}</a> : m[8]);
    } else if (m[10] != null) push(<a href={m[10]} target="_blank" rel="noreferrer noopener">{m[10]}</a>);
    rest = rest.slice(m.index + m[0].length);
  }
  return out;
}

/** Text with its line breaks kept (chat answers rely on them). */
const lines = (text: string, onPath: ((p: string) => void) | undefined, key: string) =>
  text.split("\n").flatMap((l, i) => (i ? [<br key={`${key}br${i}`} />, ...inline(l, onPath, `${key}l${i}`)] : inline(l, onPath, `${key}l${i}`)));

function renderBlock(b: Block, k: string, onPath?: (p: string) => void): ReactNode {
  switch (b.t) {
    case "h": {
      const Tag = (`h${Math.min(6, b.level + 2)}`) as "h3"; // answers sit inside a page: start small
      return <Tag key={k} className="md-h">{inline(b.text, onPath, k)}</Tag>;
    }
    case "p": return <p key={k}>{lines(b.lines.join("\n"), onPath, k)}</p>;
    case "code": return <pre key={k} className="md-code"><code>{b.text}</code></pre>;
    case "quote": return <blockquote key={k}>{parseBlocks(b.lines.join("\n")).map((x, i) => renderBlock(x, `${k}q${i}`, onPath))}</blockquote>;
    case "hr": return <hr key={k} />;
    case "table":
      return (
        <div key={k} className="md-table">
          <table>
            <thead><tr>{b.head.map((c, i) => <th key={i}>{inline(c, onPath, `${k}h${i}`)}</th>)}</tr></thead>
            <tbody>{b.rows.map((r, ri) => <tr key={ri}>{b.head.map((_, ci) => <td key={ci}>{inline(r[ci] ?? "", onPath, `${k}r${ri}c${ci}`)}</td>)}</tr>)}</tbody>
          </table>
        </div>
      );
    case "list": {
      const items = b.items.map((it, i) => (
        <li key={i}>{lines(it.text, onPath, `${k}li${i}`)}{it.children.map((c, ci) => renderBlock(c, `${k}li${i}c${ci}`, onPath))}</li>
      ));
      return b.ordered ? <ol key={k} start={b.start}>{items}</ol> : <ul key={k}>{items}</ul>;
    }
  }
}

export function Markdown({ text, onPath, className }: { text: string; onPath?: (path: string) => void; className?: string }) {
  return <div className={`md${className ? ` ${className}` : ""}`}>{parseBlocks(text).map((b, i) => renderBlock(b, `b${i}`, onPath))}</div>;
}
