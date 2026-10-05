import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { KeyPool } from "../lib/keys.js";

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sousuo-state-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const statePath = path.join(dir, "state.json");
  const keysPath = path.join(dir, "keys");
  await writeFile(keysPath, "fixture-one\nfixture-two\n", { mode: 0o600 });
  return { statePath, pool: new KeyPool({ keysPath, statePath }) };
}

test("missing rotation state initializes the first slot", async (t) => {
  const { pool, statePath } = await fixture(t);
  assert.equal((await pool.current()).index, 0);
  assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")), { index: 0 });
});

test("corrupt rotation state reports failure without overwriting evidence", async (t) => {
  const { pool, statePath } = await fixture(t);
  const broken = '{"index": private-state-content';
  await writeFile(statePath, broken);
  await assert.rejects(() => pool.current(), (error) => {
    assert.match(error.message, /invalid JSON/);
    assert.equal(error.message.includes("private-state-content"), false);
    return true;
  });
  assert.equal(await readFile(statePath, "utf8"), broken);
});

test("invalid rotation state shapes and indices remain visible failures", async (t) => {
  for (const value of [null, [], {}, { index: -1 }, { index: 0.5 }, { index: "1" }]) {
    const { pool, statePath } = await fixture(t);
    const original = JSON.stringify(value);
    await writeFile(statePath, original);
    await assert.rejects(() => pool.current(), /non-negative integer index/);
    assert.equal(await readFile(statePath, "utf8"), original);
  }
});

test("rotation state read errors are not treated as a missing file", async (t) => {
  const { pool, statePath } = await fixture(t);
  await mkdir(statePath);
  await assert.rejects(() => pool.current(), /cannot read rotation state/);
});

test("a valid stored index beyond a changed key list resets safely", async (t) => {
  const { pool, statePath } = await fixture(t);
  await writeFile(statePath, JSON.stringify({ index: 8 }));
  assert.equal((await pool.current()).index, 0);
  assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")), { index: 0 });
});
