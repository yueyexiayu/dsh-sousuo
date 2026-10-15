import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Run the real package manager against an isolated fixture, never the desktop profile.
// No real keys/state/credentials are read: only public package inputs are copied.
const sourceRoot = fileURLToPath(new URL('..', import.meta.url));
const pnpmEntry = process.env.DSH_PROFILE_TEST_PNPM;
if (!pnpmEntry) {
  throw new Error('Set DSH_PROFILE_TEST_PNPM to the current desktop bundle runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs.');
}

function runPnpm(cwd, home, args) {
  const result = spawnSync(process.execPath, [pnpmEntry, ...args], {
    cwd,
    env: { HOME: home, PATH: path.dirname(process.execPath), CI: 'true' },
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 2_000_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `pnpm ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

test('file dependency stays installed across normal and frozen installs without packaging local secrets', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sousuo-profile-install-'));
  try {
    const home = path.join(root, 'home');
    const source = path.join(root, 'plugins', 'sousuo');
    const profile = path.join(root, 'profiles', 'desktop');
    await Promise.all([mkdir(home, { recursive: true }), mkdir(source, { recursive: true }), mkdir(profile, { recursive: true })]);
    const manifest = JSON.parse(await readFile(path.join(sourceRoot, 'package.json'), 'utf8'));
    assert.equal(manifest.name, 'sousuo');
    assert.deepEqual(manifest.files, ['lib/', 'cordis.patch.yml', 'keys.example', 'LICENSE', 'README.md']);
    await writeFile(path.join(source, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    for (const input of manifest.files) {
      await cp(path.join(sourceRoot, input), path.join(source, input), { recursive: true });
    }
    // Sentinels prove the package allowlist excludes these names, without touching real data.
    for (const name of ['keys', 'state.json', '.credentials.yaml']) {
      await writeFile(path.join(source, name), `FAKE_TEST_ONLY_${name}\n`);
    }
    const packed = JSON.parse(runPnpm(source, home, ['pack', '--dry-run', '--json']));
    const packageInfo = Array.isArray(packed) ? packed[0] : packed;
    const paths = packageInfo.files.map(entry => typeof entry === 'string' ? entry : entry.path);
    assert(paths.includes('lib/index.js'), 'pack metadata must contain the Host entry');
    for (const name of ['keys', 'state.json', '.credentials.yaml']) {
      assert(!paths.some(value => value === name || value.endsWith(`/${name}`)), `pack included ${name}`);
    }
    assert(!paths.some(value => value.startsWith('node_modules/')), 'pack must not embed local dependencies');

    await writeFile(path.join(profile, 'package.json'), JSON.stringify({
      name: 'sousuo-isolated-profile', private: true,
      dependencies: { sousuo: 'file:../../plugins/sousuo' },
    }, null, 2));
    await writeFile(path.join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n');
    const installed = path.join(profile, 'node_modules', 'sousuo');
    const sourceEntry = await readFile(path.join(source, 'lib', 'index.js'), 'utf8');
    for (const flags of [[], [], ['--frozen-lockfile']]) {
      runPnpm(profile, home, ['install', '--offline', '--ignore-scripts', '--store-dir', path.join(root, 'store'), ...flags]);
      const resolved = await realpath(installed);
      const profileReal = await realpath(profile);
      assert(resolved.startsWith(`${profileReal}${path.sep}`), 'file install must stay physically inside the profile');
      assert((await stat(path.join(installed, 'lib', 'index.js'))).isFile());
      assert.equal(await readFile(path.join(installed, 'lib', 'index.js'), 'utf8'), sourceEntry);
      const installedManifest = JSON.parse(await readFile(path.join(installed, 'package.json'), 'utf8'));
      assert.equal(installedManifest.version, manifest.version);
      for (const name of ['keys', 'state.json', '.credentials.yaml']) {
        await assert.rejects(stat(path.join(installed, name)), { code: 'ENOENT' });
      }
    }
    const lock = await readFile(path.join(profile, 'pnpm-lock.yaml'), 'utf8');
    assert.match(lock, /specifier: file:\.\.\/\.\.\/plugins\/sousuo/);
    assert.match(lock, /type: directory/);

    // A source update must refresh both package metadata and code, not just keep an old copy alive.
    const updatedVersion = '99.0.0-fixture.1';
    const updatedEntry = `${sourceEntry}\n// harmless isolated update marker\n`;
    // Editors commonly replace files atomically; in-place writes would also change pnpm hardlinks
    // and falsely make a stale installed copy look synchronized.
    for (const [relative, content] of [
      ['package.json', JSON.stringify({ ...manifest, version: updatedVersion }, null, 2)],
      ['lib/index.js', updatedEntry],
    ]) {
      const target = path.join(source, relative);
      const temporary = `${target}.fixture-tmp`;
      await writeFile(temporary, content, { flag: 'wx' });
      await rename(temporary, target);
    }
    const newModule = 'export const fixtureAddedModule = true;\n';
    await writeFile(path.join(source, 'lib', 'fixture-added.js'), newModule, { flag: 'wx' });
    // A plain install/update (including --force) can reuse the existing file snapshot.
    // Let pnpm remove its installed copy and dependency record before resolving the source again.
    runPnpm(profile, home, ['remove', 'sousuo', '--config.ignore-scripts=true', '--store-dir', path.join(root, 'store')]);
    await assert.rejects(stat(installed), { code: 'ENOENT' });
    const synchronizationOutput = runPnpm(profile, home, ['add', 'file:../../plugins/sousuo', '--offline', '--ignore-scripts', '--store-dir', path.join(root, 'store')]);
    const refreshedProfile = JSON.parse(await readFile(path.join(profile, 'package.json'), 'utf8'));
    assert.equal(refreshedProfile.dependencies.sousuo, 'file:../../plugins/sousuo');
    for (const flags of [[], ['--offline', '--frozen-lockfile']]) {
      if (flags.length) {
        runPnpm(profile, home, ['install', '--ignore-scripts', '--store-dir', path.join(root, 'store'), ...flags]);
      }
      const updatedManifest = JSON.parse(await readFile(path.join(installed, 'package.json'), 'utf8'));
      assert.equal(updatedManifest.version, updatedVersion, `Source refresh failed:\n${synchronizationOutput}`);
      assert.equal(await readFile(path.join(installed, 'lib', 'index.js'), 'utf8'), updatedEntry);
      assert.equal(await readFile(path.join(installed, 'lib', 'fixture-added.js'), 'utf8'), newModule);
      assert((await realpath(installed)).startsWith(`${await realpath(profile)}${path.sep}`));
    }
  } finally {
    // root is the exact directory returned by mkdtemp above, never a user/profile path.
    await rm(root, { recursive: true, force: true });
  }
});
