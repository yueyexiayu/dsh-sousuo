import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
}

export function defaultKeysPath() {
  return path.join(dshHome(), "plugins", "sousuo", "keys");
}

export function defaultStatePath() {
  return path.join(dshHome(), "plugins", "sousuo", "state.json");
}

export function parseKeys(text) {
  const keys = [];
  for (const line of String(text || "").split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    keys.push(trimmed);
  }
  return keys;
}

export class KeyPool {
  constructor(options = {}) {
    this.keysPath = options.keysPath || defaultKeysPath();
    this.statePath = options.statePath || defaultStatePath();
    this.chain = Promise.resolve();
  }

  serialize(fn) {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }

  async list() {
    let text;
    try {
      text = await fs.readFile(this.keysPath, "utf8");
    } catch (error) {
      if (error && error.code === "ENOENT") {
        throw new Error(`sousuo keys file is missing: ${this.keysPath}`);
      }
      throw error;
    }
    const keys = parseKeys(text);
    if (keys.length === 0) {
      throw new Error(`sousuo keys file has no keys: ${this.keysPath}`);
    }
    return keys;
  }

  async readState() {
    try {
      const raw = JSON.parse(await fs.readFile(this.statePath, "utf8"));
      return raw && typeof raw === "object" ? raw : {};
    } catch (error) {
      if (error && error.code === "ENOENT") return {};
      return {};
    }
  }

  async writeState(state) {
    await fs.writeFile(this.statePath, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });
  }

  normalizeIndex(index, count) {
    if (!Number.isInteger(index) || index < 0 || index >= count) return 0;
    return index;
  }

  async snapshot() {
    return this.serialize(async () => {
      const keys = await this.list();
      const state = await this.readState();
      const index = this.normalizeIndex(state.index, keys.length);
      if (index !== state.index) await this.writeState({ index });
      return { keys, index, count: keys.length };
    });
  }

  async current() {
    const snap = await this.snapshot();
    return { key: snap.keys[snap.index], index: snap.index, count: snap.count };
  }

  async advance(fromIndex) {
    return this.serialize(async () => {
      const keys = await this.list();
      const state = await this.readState();
      let index = this.normalizeIndex(state.index, keys.length);
      if (index === fromIndex) {
        index = (index + 1) % keys.length;
        await this.writeState({ index });
      }
      return index;
    });
  }
}
