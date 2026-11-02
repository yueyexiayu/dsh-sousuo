import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { settingsHandler, loadSettings } from '../lib/settings.js';
import { AnySearchClient } from '../lib/client.js';
import { registerHooks } from 'node:module';
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === '@deepseek-ai/dsh-web') return { url: 'data:text/javascript,export class WebError extends Error {}', shortCircuit: true };
  return next(specifier, context);
} });
const { AnySearchProvider } = await import('../lib/provider.js');
hooks.deregister();

const url = 'http://localhost/api/sousuo/settings';
const defaults = { maxResults: null, zone: 'auto', language: '' };
function post(settings, revision, headers = {}) { return new Request(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ settings, revision }) }); }

test('settings persist privately, reject stale writes, invalid fields and cross-origin posts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sousuo-settings-'));
  const file = join(dir, 'settings.json');
  try {
    const handler = settingsHandler(file), secondHost = settingsHandler(file);
    const initial = await (await handler(new Request(url))).json();
    assert.deepEqual(initial.settings, defaults);
    const next = { maxResults: 5, zone: 'intl', language: 'en-US' };
    const saved = await handler(post(next, initial.revision));
    assert.equal(saved.status, 200);
    assert.deepEqual(await loadSettings(file), next);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await secondHost(post(defaults, initial.revision))).status, 409);
    assert.equal((await handler(post({ ...next, apiKey: 'secret' }, (await saved.json()).revision))).status, 400);
    assert.equal((await handler(post(defaults, 'absent', { origin: 'https://evil.test' }))).status, 403);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), next);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('saved defaults reach HTTP search; explicit advanced arguments override and changes apply live', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sousuo-search-'));
  const file = join(dir, 'settings.json');
  try {
    const handler = settingsHandler(file);
    const seen = [];
    const client = new AnySearchClient({ baseURL: 'https://api.example.test', pool: { snapshot: async () => [{ key: 'fixture', index: 0, count: 1 }] }, getSearchDefaults: () => loadSettings(file), transportHooks: { proxyPolicy: 'direct', fetch: async (_url, init) => { seen.push(JSON.parse(init.body)); return new Response(JSON.stringify({ code: 0, message: 'ok', data: { results: [], metadata: { total_results: 0, search_time_ms: 0 } } }), { headers: { 'content-type': 'application/json' } }); } } });
    const settings = { maxResults: 5, zone: 'cn', language: 'zh-CN' };
    assert.equal((await handler(post(settings, 'absent'))).status, 200);
    await client.search({ query: 'a' });
    await client.search({ query: 'b', maxResults: 2, zone: 'intl', language: 'en' });
    const provider = new AnySearchProvider(client, () => loadSettings(file));
    await provider.search({ query: 'c', maxResults: 8 });
    assert.deepEqual(seen, [
      { query: 'a', max_results: 5, zone: 'cn', language: 'zh-CN' },
      { query: 'b', max_results: 2, zone: 'intl', language: 'en' },
      { query: 'c', max_results: 5, zone: 'cn', language: 'zh-CN' },
    ]);
    const current = await (await handler(new Request(url))).json();
    assert.equal((await handler(post(defaults, current.revision))).status, 200);
    await provider.search({ query: 'd', maxResults: 8 });
    assert.deepEqual(seen[3], { query: 'd', max_results: 8 });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
