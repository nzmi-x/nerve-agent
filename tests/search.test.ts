import { test, expect } from "bun:test";
import { parseResults } from "../src/tools/search.ts";

// A trimmed-down lite.duckduckgo.com/lite/ results page: two results, each a `result-link` anchor (with
// a `/l/?uddg=` redirect href) followed by a `result-snippet` cell — plus chrome anchors we must ignore.
const SAMPLE = `
<html><body>
<a href="/lite/?q=prev" class="nav-link">&lt; Prev</a>
<table>
  <tr><td>1.&nbsp;</td><td>
    <a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs&rut=abc" class='result-link'>Example &amp; Docs</a>
  </td></tr>
  <tr><td>&nbsp;</td><td class='result-snippet'>The canonical <b>example</b> site &mdash; reserved for docs.</td></tr>
  <tr><td>2.&nbsp;</td><td>
    <a class='result-link' href="https://bun.sh/">Bun &#8212; a fast runtime</a>
  </td></tr>
  <tr><td>&nbsp;</td><td class='result-snippet'>Bun is an all-in-one toolkit.</td></tr>
</table>
<a href="/lite/?q=next" class="nav-link">Next &gt;</a>
</body></html>`;

test("parseResults: extracts title/url/snippet, unwraps the uddg redirect, ignores chrome anchors", () => {
  const r = parseResults(SAMPLE, 8);
  expect(r).toHaveLength(2); // the two result-link anchors, not the prev/next nav links
  expect(r[0]).toEqual({
    title: "Example & Docs", // entities decoded
    url: "https://example.com/docs", // uddg redirect unwrapped
    snippet: "The canonical example site — reserved for docs.", // tags stripped, &mdash; decoded
  });
  expect(r[1]!.title).toBe("Bun — a fast runtime");
  expect(r[1]!.url).toBe("https://bun.sh/"); // class-before-href attribute order also works
  expect(r[1]!.snippet).toBe("Bun is an all-in-one toolkit.");
});

test("parseResults: respects the max cap and tolerates missing snippets", () => {
  expect(parseResults(SAMPLE, 1)).toHaveLength(1);
  expect(parseResults("<a class='result-link' href='https://x.test/'>X</a>", 8)).toEqual([
    { title: "X", url: "https://x.test/", snippet: "" },
  ]);
});
