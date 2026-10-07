import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { AnySearchClientError } from '../lib/client.js';
import { SEARCH_FOLLOWTHROUGH_FOOTER } from '../lib/followthrough.js';
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === '@deepseek-ai/dsh-tools') return { url: 'data:text/javascript,export const defineTool = tool => tool;', shortCircuit: true };
  return next(specifier, context);
} });
const { registerAdvancedSearchTool, formatAdvancedSearchOutput } = await import('../lib/tools/search.js');
const { registerBatchSearchTool, executeBatchSearch, formatBatchSearchOutput, parseBatchSearchItems } = await import('../lib/tools/batch.js');
hooks.deregister();
const metadata = { totalResults: 1, searchTimeMs: 1 };
function capture(register, client, budget) {
  let tool;
  register({ tools: { register: value => { tool = value; } } }, client, budget);
  return tool;
}
function fixture(count = 1) {
  return { requestId: 'R'.repeat(250_000), metadata: { ...metadata, totalResults: count }, results: Array.from({ length: count }, (_, i) => ({
    title: 'T'.repeat(150_000), url: `https://example.test/${i}`, snippet: 'S'.repeat(150_000), content: 'C'.repeat(210_000),
  })) };
}
function assertBoundedText(text, budget) {
  assert(text.length <= budget, `render ${text.length} exceeds ${budget}`);
  if (budget >= 500) {
    assert(text.endsWith(SEARCH_FOLLOWTHROUGH_FOOTER));
    assert.match(text, /untrusted/i);
    assert.match(text, /truncated/i);
  }
  // Links must be complete, never sliced midway through a URL.
  const openingLinks = (text.match(/\]\(</g) ?? []).length;
  const closingLinks = (text.match(/>\)/g) ?? []).length;
  assert.equal(openingLinks, closingLinks);
}

test('advanced bounds metadata, sources and entire rendered text even without page content', async () => {
  const tool = capture(registerAdvancedSearchTool, { search: async () => fixture(60) }, 12_000);
  const value = await tool.execute({ query: 'fixture', includeContent: false }, {});
  assert(value.results.length <= 50);
  assert(value.results.every(item => item.title.length <= 1_000 && item.snippet.length <= 2_000 && !('content' in item)));
  assert(value.requestId.length <= 256);
  assert.equal(value.renderedContentTruncated, true);
  assert.equal(tool.output.presentationMeta({}, value).truncated, true);
  assertBoundedText(tool.output.render({}, value)[0].text, 12_000);
  assert.deepEqual(Object.keys(value).sort(), ['metadata', 'renderedContentTruncated', 'requestId', 'results']);
});

test('one aggregate budget covers all five batch searches, query, errors, sources and content', async () => {
  const parsed = Array.from({ length: 5 }, (_, i) => ({ request: { query: String(i) + 'Q'.repeat(250_000) }, includeContent: true }));
  const client = { search: async request => {
    // Deliberately bypass client normalization to exercise the tool's independent defense.
    if (request.query.startsWith('2')) throw Object.assign(Object.create(AnySearchClientError.prototype), {
      message: 'E'.repeat(250_000), requestId: 'R'.repeat(250_000), retryAfter: 'A'.repeat(250_000), httpStatus: 429,
    });
    return fixture(60);
  } };
  const value = await executeBatchSearch(client, parsed, undefined, 12_000);
  assert.deepEqual(value.summary, { total: 5, succeeded: 4, failed: 1 });
  assert(value.items.every(item => item.query.length <= 1_000));
  assert(parsed.every(item => item.request.query.length === 250_001), 'output bounds must not mutate API requests');
  for (const item of value.items.filter(item => item.ok)) {
    assert(item.results.length <= 50);
    assert(item.results.every(result => result.title.length <= 1_000 && result.snippet.length <= 2_000));
    assert(item.results.reduce((total, result) => total + result.content.length, 0) <= 200_000);
  }
  const error = value.items[2].error;
  assert(error.message.length <= 2_000 && error.requestId.length <= 256 && error.retryAfter.length <= 256);
  assert.equal(value.renderedContentTruncated, true);
  assertBoundedText(formatBatchSearchOutput({ items: parsed.map(item => ({ includeContent: item.includeContent })) }, value, 12_000), 12_000);
  const tool = capture(registerBatchSearchTool, client, 12_000);
  assert.equal(tool.output.schema.properties.renderedContentTruncated.required, true);
});

test('very small budgets are hard caps and have truthful truncation flags', async () => {
  for (const budget of [1, 5, 12, 64, 128, 300, 500, 12_000]) {
    const tool = capture(registerAdvancedSearchTool, { search: async () => fixture() }, budget);
    const value = await tool.execute({ query: 'fixture', includeContent: true }, {});
    assert.equal(value.renderedContentTruncated, true);
    assertBoundedText(formatAdvancedSearchOutput(value, true, budget), budget);
    const batch = await executeBatchSearch({ search: async () => fixture() }, [{ request: { query: 'fixture' }, includeContent: true }], undefined, budget);
    assert.equal(batch.renderedContentTruncated, true);
    assertBoundedText(formatBatchSearchOutput({ items: [{ includeContent: true }] }, batch, budget), budget);
  }
});

test('normal output keeps complete citation links and footer without a false clipping flag', async () => {
  const response = { results: [{ title: 'Normal [title]', url: 'https://example.test/page', snippet: 'Small snippet', content: 'Small page body' }], metadata };
  const tool = capture(registerAdvancedSearchTool, { search: async () => response }, 12_000);
  const value = await tool.execute({ query: 'fixture', includeContent: true }, {});
  const text = tool.output.render({ includeContent: true }, value)[0].text;
  assert.equal(value.renderedContentTruncated, false);
  assert.equal(tool.output.presentationMeta({}, value).truncated, false);
  assert.match(text, /https:\/\/example\.test\/page/);
  assert.match(text, /Small page body/);
  assert(text.endsWith(SEARCH_FOLLOWTHROUGH_FOOTER));
  assert(text.length <= 12_000);
});

test('invalid or overlong URLs are omitted, not cut into misleading citation links', async () => {
  const response = { metadata, results: [
    { title: 'Unsafe', url: 'javascript:alert(1)' },
    { title: 'Long', url: 'https://example.test/' + 'p'.repeat(4_001) },
    { title: 'Good', url: 'https://example.test/good' },
  ] };
  const tool = capture(registerAdvancedSearchTool, { search: async () => response }, 12_000);
  const value = await tool.execute({ query: 'fixture' }, {});
  assert.deepEqual(value.results.map(item => item.url), ['https://example.test/good']);
  assert.equal(value.renderedContentTruncated, true);
  assert(!tool.output.render({}, value)[0].text.includes('javascript:'));
});

test('source clipping remains visible with content omitted and an empty retained source list', async () => {
  const tool = capture(registerAdvancedSearchTool, { search: async () => ({ metadata, results: [], sourcesTruncated: true, contentTruncated: true }) }, 12_000);
  const value = await tool.execute({ query: 'fixture', includeContent: false }, {});
  assert.equal(value.renderedContentTruncated, true);
  const text = tool.output.render({}, value)[0].text;
  assert.match(text, /No usable source URLs retained/);
  assert.match(text, /truncated/i);
  assert(!text.includes('No results found.'));
});

test('every budget from 1 through 1200 remains within the whole-text cap', async () => {
  const response = { metadata, results: [{ title: 'Tiny source', url: 'https://example.test/tiny', snippet: 'A short snippet', content: 'x'.repeat(1_200) }] };
  const client = { search: async () => response };
  for (let budget = 1; budget <= 1_200; budget++) {
    const tool = capture(registerAdvancedSearchTool, client, budget);
    const value = await tool.execute({ query: 'fixture', includeContent: true }, {});
    const text = tool.output.render({ includeContent: true }, value)[0].text;
    assert(text.length <= budget, `advanced cap ${budget}`);
    assert.equal(value.renderedContentTruncated, true);
    const batch = await executeBatchSearch(client, [{ request: { query: 'fixture' }, includeContent: true }], undefined, budget);
    const batchText = formatBatchSearchOutput({ items: [{ includeContent: true }] }, batch, budget);
    assert(batchText.length <= budget, `batch cap ${budget}`);
    assert.equal(batch.renderedContentTruncated, true);
  }
});

test('batch validation, concurrent ordering and cancellation semantics remain intact', async () => {
  assert.throws(() => parseBatchSearchItems([]), /at least one/);
  assert.throws(() => parseBatchSearchItems(Array.from({ length: 6 }, () => ({ query: 'fixture' }))), /at most 5/);
  assert.throws(() => parseBatchSearchItems([{ query: 'first' }, { query: 'second', maxResults: 21 }]), /maxResults/);
  const started = [];
  const settle = [];
  const pending = executeBatchSearch({ search: request => {
    started.push(request.query);
    return new Promise(resolve => settle.push(() => resolve({ metadata, results: [{ title: request.query, url: 'https://example.test/' + request.query }] })));
  } }, parseBatchSearchItems([{ query: 'first' }, { query: 'second' }]), undefined, 12_000);
  assert.deepEqual(started, ['first', 'second']);
  settle[1](); settle[0]();
  const output = await pending;
  assert.deepEqual(output.items.map(item => item.query), ['first', 'second']);
  assert.deepEqual(output.summary, { total: 2, succeeded: 2, failed: 0 });
  assert.equal(output.renderedContentTruncated, false);
  const aborted = Object.assign(Object.create(AnySearchClientError.prototype), { kind: 'aborted', message: 'fixture cancelled' });
  await assert.rejects(executeBatchSearch({ search: async () => { throw aborted; } }, [{ request: { query: 'fixture' } }], undefined, 12_000), error => error === aborted);
});

test('renderers also defend against unnormalized direct values', () => {
  const raw = fixture(60);
  assertBoundedText(formatAdvancedSearchOutput({ ...raw, renderedContentTruncated: false }, true, 12_000), 12_000);
  const batch = { items: [{ index: 0, query: 'Q'.repeat(250_000), ok: true, ...raw }], summary: { total: 1, succeeded: 1, failed: 0 }, renderedContentTruncated: false };
  assertBoundedText(formatBatchSearchOutput({ items: [{ includeContent: true }] }, batch, 12_000), 12_000);
});
