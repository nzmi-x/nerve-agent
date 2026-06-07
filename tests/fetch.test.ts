import { test, expect } from "bun:test";
import { htmlToMarkdown, fetchTool } from "../src/tools/fetch.ts";

test("htmlToMarkdown: headings/links/lists/code/bold; drops chrome; decodes entities", () => {
  const md = htmlToMarkdown(`
    <html><head><title>x</title><style>.a{color:red}</style></head><body>
      <h1>Title</h1>
      <p>Hello <strong>world</strong> &amp; <a href="/x">link</a>.</p>
      <script>evil()</script>
      <ul><li>one</li><li>two</li></ul>
      <pre>code&lt;here&gt;</pre>
    </body></html>`);
  expect(md).toContain("# Title");
  expect(md).toContain("Hello **world** & [link](/x).");
  expect(md).toContain("- one");
  expect(md).toContain("- two");
  expect(md).toContain("```");
  expect(md).toContain("code<here>"); // entities decoded inside <pre>
  expect(md).not.toContain("evil()"); // <script> dropped
  expect(md).not.toContain(".a{color:red}"); // <style> dropped
});

test("htmlToMarkdown: collapses whitespace and blank lines", () => {
  expect(htmlToMarkdown("<p>a</p>\n\n\n\n<p>b</p>")).toBe("a\n\nb");
});

test("fetch tool: validates url, readonly (PLAN-safe)", async () => {
  expect(await fetchTool.run({ url: 123 as unknown as string }, { cwd: "." })).toContain("must be a string");
  expect(fetchTool.readonly).toBe(true);
  expect(fetchTool.name).toBe("fetch");
});
