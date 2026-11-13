// HTML sanitization of rendered markdown. A dependency bump or config tweak
// could quietly let script through while every note still looks fine.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createNote, startTestServer, type TestServer } from "../helpers/server-harness";

let server: TestServer;
let shareId: string;

beforeAll(async () => {
  server = await startTestServer();
  const note = await createNote(server, "x");
  await server.requestPath(`/api/notes/${note.id}`, { method: "PUT", body: { shareAccess: "view" } as never });
  const collab = (await (await server.requestPath(`/api/notes/${note.id}/collab`)).json()) as { shareId: string };
  shareId = collab.shareId;
});

afterAll(async () => {
  await server?.stop();
});

async function renderOwner(markdown: string) {
  const response = await server.requestPath("/api/render", { method: "POST", body: { markdown } as never });
  return ((await response.json()) as { html: string }).html;
}

async function renderShared(markdown: string) {
  const response = await fetch(`${server.baseUrl}/api/share/${shareId}/render`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ markdown }),
  });
  return ((await response.json()) as { html: string }).html;
}

const HOSTILE: [string, string][] = [
  ["script tag", "<script>alert(1)</script>"],
  ["img onerror", '<img src="x" onerror="alert(1)">'],
  ["event handler on allowed tag", '<a href="https://ok.example" onclick="alert(1)">x</a>'],
  ["javascript: markdown link", "[click](javascript:alert(1))"],
  ["javascript: html link", '<a href="javascript:alert(1)">x</a>'],
  ["obfuscated javascript: link", '<a href="JaVaScRiPt&colon;alert(1)">x</a>'],
  ["data: image", "![x](data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+)"],
  ["iframe", '<iframe src="https://evil.example"></iframe>'],
  ["svg onload", "<svg onload=alert(1)></svg>"],
  ["style attribute", '<p style="position:fixed;inset:0">overlay</p>'],
  ["style tag", "<style>body{display:none}</style>"],
  ["form", '<form action="https://evil.example"><input name="pw"></form>'],
  ["mermaid breakout", "```mermaid\n</pre><script>alert(1)</script>\n```"],
  ["code language breakout", '```"><script>alert(1)</script>\nx\n```'],
];

const FORBIDDEN = [
  /<script/i,
  /\son\w+\s*=/i,
  /javascript:/i,
  /data:/i,
  /<iframe/i,
  /<svg/i,
  /style=/i,
  /<style/i,
  /<form/i,
];

describe("renderMarkdown strips dangerous HTML", () => {
  it.each(HOSTILE)("%s", async (_label, markdown) => {
    for (const html of [await renderOwner(markdown), await renderShared(markdown)]) {
      expect({ html, matched: FORBIDDEN.filter((pattern) => pattern.test(html)).map(String) }).toEqual({
        html,
        matched: [],
      });
    }
  });
});

describe("renderMarkdown keeps the good stuff", () => {
  it("links get safe target/rel", async () => {
    const html = await renderOwner("[site](https://example.com)");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('target="_blank"');
  });

  it("images", async () => {
    expect(await renderOwner("![alt](https://example.com/a.png)")).toContain(
      '<img src="https://example.com/a.png" alt="alt"',
    );
  });

  it("code highlighting", async () => {
    const html = await renderOwner("```js\nconst x = 1;\n```");
    expect(html).toContain('class="hljs language-js"');
    expect(html).toMatch(/<span class="hljs-keyword">const<\/span>/);
  });

  it("mermaid blocks", async () => {
    expect(await renderOwner("```mermaid\ngraph TD; A-->B\n```")).toContain('<pre class="mermaid">');
  });

  it("task list checkboxes", async () => {
    const html = await renderOwner("- [ ] todo\n- [x] done");
    expect(html).toContain('<span class="task-checkbox"></span>');
    expect(html).toContain('<span class="task-checkbox checked"></span>');
    expect(html).not.toContain("<input");
  });

  it("tables", async () => {
    expect(await renderOwner("| a | b |\n|---|---|\n| 1 | 2 |")).toContain("<table>");
  });
});
