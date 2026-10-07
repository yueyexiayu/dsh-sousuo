import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, readdir, stat } from "node:fs/promises";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { KeyPool, parseKeys } from "../lib/keys.js";

test("parseKeys rejects control characters before trimming and never echoes the key", () => {
  for (const control of ["\u0000", "\u0001", "\t", "\r", "\u007f", "\u0085", "\u009f"]) {
    assert.throws(() => parseKeys(`# fixture\n${control}synthetic_secret\n`), {
      message: "sousuo keys file contains a control character on line 2",
    });
  }
  assert.deepEqual(parseKeys("# fixture\r\n  k1  \r\nk2\r\n"), ["k1", "k2"]);
});

async function fixture(initial = { index: 0 }, keyText = "k1\nk2\nk3\n") {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sousuo-keys-fixture-"));
  const keysPath = path.join(dir, "keys");
  const statePath = path.join(dir, "state.json");
  await writeFile(keysPath, keyText, { mode: 0o600 });
  await writeFile(statePath, typeof initial === "string" ? initial : `${JSON.stringify(initial)}\n`, { mode: 0o600 });
  return { dir, keysPath, statePath, pool: new KeyPool({ keysPath, statePath }) };
}

async function assertOldStateIntact(f, original) {
  assert.equal(await readFile(f.statePath, "utf8"), original);
  assert.deepEqual((await readdir(f.dir)).sort(), ["keys", "state.json"]);
}

function diskError(code) {
  return Object.assign(new Error(`fixture ${code}`), { code });
}

test("snapshot contains each configured slot once in stable current-first ring order", async () => {
  const f = await fixture({ index: 1 }, "k1\nk2\nk3\nk1\n");
  const slots = await f.pool.snapshot();
  assert.deepEqual(slots, [
    { key: "k2", index: 1, count: 4 },
    { key: "k3", index: 2, count: 4 },
    { key: "k1", index: 3, count: 4 },
    { key: "k1", index: 0, count: 4 },
  ]);
  await f.pool.advance(1);
  await writeFile(f.keysPath, "new1\nnew2\n", { mode: 0o600 });
  assert.deepEqual(slots.map((slot) => slot.key), ["k2", "k3", "k1", "k1"]);
  assert.deepEqual(await f.pool.current(), { key: "new1", index: 0, count: 2 });
});

test("atomic state publication uses an exclusive same-directory 0600 fsynced temporary file", async (t) => {
  const f = await fixture({ index: 0 });
  await fs.chmod(f.statePath, 0o644);
  const originalOpen = fs.open.bind(fs);
  const originalRename = fs.rename.bind(fs);
  const events = [];
  t.mock.method(fs, "open", async (filename, flags, mode) => {
    assert.equal(path.dirname(filename), f.dir);
    assert.notEqual(filename, f.statePath);
    assert.equal(flags, "wx");
    assert.equal(mode, 0o600);
    const handle = await originalOpen(filename, flags, mode);
    return {
      writeFile: async (...args) => { await handle.writeFile(...args); events.push("written"); },
      sync: async () => { await handle.sync(); events.push("synced"); },
      close: async () => { await handle.close(); events.push("closed"); },
    };
  });
  t.mock.method(fs, "rename", async (from, to) => {
    assert.equal(await readFile(f.statePath, "utf8"), '{"index":0}\n');
    assert.equal(await readFile(from, "utf8"), '{"index":1}\n');
    assert.equal(to, f.statePath);
    events.push("renamed");
    return originalRename(from, to);
  });
  assert.equal(await f.pool.advance(0), 1);
  assert.deepEqual(events, ["written", "synced", "closed", "renamed"]);
  assert.equal((await stat(f.statePath)).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(f.dir)).sort(), ["keys", "state.json"]);
});

test("partial temporary write ENOSPC keeps old state and removes only the owned temporary file", async (t) => {
  const f = await fixture({ index: 0 });
  const original = await readFile(f.statePath, "utf8");
  const originalOpen = fs.open.bind(fs);
  t.mock.method(fs, "open", async (...args) => {
    const handle = await originalOpen(...args);
    return {
      writeFile: async () => { await handle.writeFile('{"index":'); throw diskError("ENOSPC"); },
      sync: () => handle.sync(),
      close: () => handle.close(),
    };
  });
  await assert.rejects(f.pool.advance(0), { code: "ENOSPC" });
  await assertOldStateIntact(f, original);
  t.mock.restoreAll();
  assert.equal(await f.pool.advance(0), 1);
});

test("temporary file sync failure cannot publish partial or unsynced state", async (t) => {
  const f = await fixture({ index: 0 });
  const original = await readFile(f.statePath, "utf8");
  const originalOpen = fs.open.bind(fs);
  t.mock.method(fs, "open", async (...args) => {
    const handle = await originalOpen(...args);
    return {
      writeFile: (...writeArgs) => handle.writeFile(...writeArgs),
      sync: async () => { throw diskError("EIO"); },
      close: () => handle.close(),
    };
  });
  await assert.rejects(f.pool.advance(0), { code: "EIO" });
  await assertOldStateIntact(f, original);
});

test("failed exclusive creation never unlinks a temporary path owned by another writer", async (t) => {
  const f = await fixture({ index: 0 });
  const original = await readFile(f.statePath, "utf8");
  let collisionPath;
  t.mock.method(fs, "open", async (filename) => {
    collisionPath = filename;
    await writeFile(filename, "unrelated synthetic writer", { mode: 0o600 });
    throw diskError("EEXIST");
  });
  const unlink = t.mock.method(fs, "unlink", async () => { throw new Error("must not unlink unowned file"); });
  await assert.rejects(f.pool.advance(0), { code: "EEXIST" });
  assert.equal(unlink.mock.callCount(), 0);
  assert.equal(await readFile(collisionPath, "utf8"), "unrelated synthetic writer");
  assert.equal(await readFile(f.statePath, "utf8"), original);
});

test("cleanup failure remains visible alongside the original publication failure", async (t) => {
  const f = await fixture({ index: 0 });
  const original = await readFile(f.statePath, "utf8");
  t.mock.method(fs, "rename", async () => { throw diskError("EACCES"); });
  t.mock.method(fs, "unlink", async () => { throw diskError("EPERM"); });
  await assert.rejects(f.pool.advance(0), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors.map((failure) => failure.code), ["EACCES", "EPERM"]);
    assert.equal(error.cause.code, "EACCES");
    return true;
  });
  assert.equal(await readFile(f.statePath, "utf8"), original);
  const remaining = (await readdir(f.dir)).filter((entry) => entry.endsWith(".tmp"));
  assert.equal(remaining.length, 1);
  assert.equal((await stat(path.join(f.dir, remaining[0]))).mode & 0o777, 0o600);
});

test("rename failure leaves old state readable and cleans up the complete temporary file", async (t) => {
  const f = await fixture({ index: 0 });
  const original = await readFile(f.statePath, "utf8");
  t.mock.method(fs, "rename", async () => { throw diskError("EACCES"); });
  await assert.rejects(f.pool.advance(0), { code: "EACCES" });
  await assertOldStateIntact(f, original);
});

test("bad persisted JSON and invalid indices remain explicit failures with no overwrite", async () => {
  for (const original of ['{"index":', '{"index":-1}', '{"index":1.5}', '[]', 'null']) {
    const f = await fixture(original);
    await assert.rejects(f.pool.snapshot(), /sousuo rotation state/u);
    await assert.rejects(f.pool.current(), /sousuo rotation state/u);
    await assert.rejects(f.pool.advance(0), /sousuo rotation state/u);
    await assertOldStateIntact(f, original);
  }
});

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
