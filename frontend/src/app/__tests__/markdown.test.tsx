import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown, parseBlocks } from "../Markdown";

const html = (md: string, onPath?: (p: string) => void) => renderToStaticMarkup(<Markdown text={md} onPath={onPath} />);

describe("Markdown for AI answers", () => {
  it("renders the shapes agents answer with", () => {
    const out = html("Intro line\nsecond line\n\n- **Model:** `agents/config.py:12` reads `LLM_MODEL`\n- *one* ~~two~~\n  - nested\n\n1. first\n2. second\n\n> a quote\n\n```py\nx = 1\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |");
    expect(out).toContain("<p>Intro line<br/>second line</p>");
    expect(out).toContain("<strong>Model:</strong>");
    expect(out).toContain("<code>agents/config.py:12</code>");
    expect(out).toContain("<em>one</em> <del>two</del>");
    expect(out).toMatch(/<li>.*<ul><li>nested<\/li><\/ul><\/li>/);
    expect(out).toContain('<ol start="1"><li>first</li><li>second</li></ol>');
    expect(out).toContain("<blockquote><p>a quote</p></blockquote>");
    expect(out).toContain('<pre class="md-code"><code>x = 1</code></pre>');
    expect(out).toContain("<th>a</th>");
    expect(out).toContain("<td>2</td>");
  });

  it("never renders HTML or unsafe links from an answer", () => {
    const out = html('<img src=x onerror=alert(1)> [click](javascript:alert(1)) [ok](https://example.com)');
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;img");
    expect(out).not.toContain("javascript:");
    expect(out).toContain('<a href="https://example.com" target="_blank" rel="noreferrer noopener">ok</a>');
  });

  it("makes file paths clickable only when asked, and only real file paths", () => {
    const out = html("See `src/worker.ts:29`, `values.yaml.gotmpl`, `zai-org/glm-5-maas` and `LLM_MODEL`.", () => {});
    expect(out.match(/class="md-path"/g)).toHaveLength(2);
    expect(out).toContain("<code>zai-org/glm-5-maas</code>");
    expect(html("`src/worker.ts`")).not.toContain("md-path");
  });

  it("keeps headings, rules and wrapped list items apart", () => {
    expect(parseBlocks("## Title\n---\n- a\n  continued\n- b").map((b) => b.t)).toEqual(["h", "hr", "list"]);
    const list: any = parseBlocks("- a\n  continued\n- b")[0];
    expect(list.items.map((i: any) => i.text)).toEqual(["a\ncontinued", "b"]);
  });
});
