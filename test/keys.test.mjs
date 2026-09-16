import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { KeyPool, parseKeys } from "../lib/keys.js";

test("parseKeys skips blanks and comments", () => {
  assert.deepEqual(parseKeys("# a\n\nas_sk_one\n  as_sk_two  \n# b\n"), ["as_sk_one", "as_sk_two"]);
});

test("pool cycles on 402 and stops after one lap", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sousuo-"));
  const keysPath = path.join(dir, "keys");
  const statePath = path.join(dir, "state.json");
  await writeFile(keysPath, "k1\nk2\nk3\n", { mode: 0o600 });
  const pool = new KeyPool({ keysPath, statePath });

  const first = await pool.current();
  assert.equal(first.index, 0);
  assert.equal(first.key, "k1");

  assert.equal(await pool.advance(0), 1);
  assert.equal((await pool.current()).key, "k2");
  assert.equal(await pool.advance(1), 2);
  assert.equal((await pool.current()).key, "k3");
  assert.equal(await pool.advance(2), 0);
  assert.equal((await pool.current()).key, "k1");

  const start = (await pool.current()).index;
  const seen = [];
  for (let i = 0; i < 3; i += 1) {
    const snap = await pool.current();
    seen.push(snap.index);
    await pool.advance(snap.index);
  }
  assert.deepEqual(seen, [start, (start + 1) % 3, (start + 2) % 3]);
});

test("concurrent 402 only advances once from the same index", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sousuo-"));
  const pool = new KeyPool({
    keysPath: path.join(dir, "keys"),
    statePath: path.join(dir, "state.json"),
  });
  await writeFile(path.join(dir, "keys"), "k1\nk2\n", { mode: 0o600 });
  const a = await pool.current();
  assert.equal(a.index, 0);
  const [i1, i2] = await Promise.all([pool.advance(0), pool.advance(0)]);
  assert.equal(i1, 1);
  assert.equal(i2, 1);
  assert.equal((await pool.current()).index, 1);
});
