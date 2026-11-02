import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keysHandler } from '../lib/keys-settings.js';

test('key management preserves comments, hides keys, prevents stale and cross-site changes, and tests explicitly', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sousuo-key-settings-'));
  const path = join(dir, 'keys');
  let calls = 0;
  const handler = keysHandler(path, { search: async () => { calls++; return { results: [] }; } });
  const other = keysHandler(path, {});
  const url = 'http://localhost/api/sousuo/keys';
  const get = async h => (await h(new Request(url))).json();
  const post = (h, body, headers = {}) => h(new Request(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }));
  try {
    await writeFile(path, '# keep this comment\nsecret-one\n', { mode: 0o600 });
    const initial = await get(handler);
    assert.equal(initial.count, 1);
    assert(!JSON.stringify(initial).includes('secret-one'));
    assert.equal((await post(handler, { action: 'add', revision: initial.revision, key: 'secret-two' }, { origin: 'https://evil.test' })).status, 403);
    const added = await post(handler, { action: 'add', revision: initial.revision, key: 'secret-two' });
    const updated = await added.json();
    assert.equal(updated.count, 2);
    assert(!JSON.stringify(updated).includes('secret-two'));
    assert.equal((await post(other, { action: 'delete', revision: initial.revision, index: 0 })).status, 409);
    assert.equal((await post(handler, { action: 'add', revision: updated.revision, key: 'bad\nkey' })).status, 400);
    assert.equal((await post(handler, { action: 'add', revision: updated.revision, key: 'secret-two' })).status, 400);
    assert.equal(calls, 0);
    assert.equal((await (await post(handler, { action: 'test' })).json()).ok, true);
    assert.equal(calls, 1);
    assert.equal((await post(handler, { action: 'delete', revision: updated.revision, index: 0 })).status, 200);
    assert.equal(await readFile(path, 'utf8'), '# keep this comment\nsecret-two\n');
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
