import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CiteContext, Markdown, clockSeconds, parseBlocks } from "../Markdown";

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

  it("turns [12:34] and [img:N] into citation chips, only for screenshots the meeting has", () => {
    const cites = { image: (id: number) => (id === 7 ? { time: "12:34", caption: "Pricing slide" } : null), openImage: () => {}, openTime: () => {} };
    const out = renderToStaticMarkup(<CiteContext.Provider value={cites}><Markdown text={"Price is $1 [img:7, 12:30]. Made up [img:99]. Link [12:34](https://x.io) and [note]."} /></CiteContext.Provider>);
    expect(out).toContain('title="Screenshot at 12:34: Pricing slide"');
    expect(out).toContain('title="Show 12:30 in the transcript">12:30</button>');
    expect(out).toContain("Made up [img:99].");
    expect(out).toContain('<a href="https://x.io"');
    expect(out).toContain("[note]");
    expect(html("Said at [1:02:03].")).toContain("Said at [1:02:03].");   // no page to jump in: plain text
    expect(clockSeconds("1:02:03")).toBe(3723);
  });
});

describe("copy for Slack", () => {
  it("turns Markdown into Slack's format", async () => {
    const { toSlack } = await import("../../local/notes");
    expect(toSlack("## Action items\n- **Aditya**: fix the *merge* conflict\n- [ ] see [PR](https://x.io/1)"))
      .toBe("*Action items*\n• *Aditya*: fix the _merge_ conflict\n• see <https://x.io/1|PR>");
  });
});
