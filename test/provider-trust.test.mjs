import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@deepseek-ai/dsh-web") {
      return {
        url: "data:text/javascript,export class WebError extends Error { constructor(message, code, options) { super(message, options); this.code = code; } }",
        shortCircuit: true,
      };
    }
    return next(specifier, context);
  },
});
const { mapAnySearchResponse, UNTRUSTED_SEARCH_NOTICE } = await import("../lib/provider.js");
hooks.deregister();

test("native search projection labels untrusted data and escapes link closers", () => {
  const mapped = mapAnySearchResponse({
    results: [{
      title: "A](https://evil.example) title",
      url: "https://example.test/page",
      snippet: "snippet](https://evil.example)",
    }],
  });
  assert.equal(mapped.content, UNTRUSTED_SEARCH_NOTICE);
  assert.equal(mapped.sources[0].title, "A\\](https://evil.example) title");
  assert.equal(mapped.sources[0].snippet, "snippet\\](https://evil.example)");
  const line = `- [${mapped.sources[0].title}](${mapped.sources[0].url}) — ${mapped.sources[0].snippet}`;
  assert.match(line, /\]\(https:\/\/example\.test\/page\) — /);
  assert.doesNotMatch(mapped.sources[0].title, /(^|[^\\])\]\(/);
  assert.doesNotMatch(mapped.sources[0].snippet, /(^|[^\\])\]\(/);
});
