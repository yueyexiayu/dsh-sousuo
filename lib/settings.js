import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const DEFAULT_SETTINGS = Object.freeze({ maxResults: null, zone: 'auto', language: '' });
export function settingsPath(home = process.env.DSH_HOME) {
  return join(typeof home === 'string' && home.trim() ? home.trim() : join(homedir(), '.dsh'), 'storages', 'sousuo', 'settings.json');
}
export function validateSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 3 || Object.keys(DEFAULT_SETTINGS).some(key => !Object.hasOwn(value, key))) throw new Error('设置字段不完整或包含未知字段');
  if (value.maxResults !== null && (!Number.isInteger(value.maxResults) || value.maxResults < 1 || value.maxResults > 20)) throw new Error('结果数量必须为 1–20 的整数或自动');
  if (!['auto', 'cn', 'intl'].includes(value.zone)) throw new Error('搜索区域无效');
  if (typeof value.language !== 'string' || (value.language !== '' && !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8}){0,3}$/.test(value.language)) || value.language.length > 35) throw new Error('语言标签无效');
  return { maxResults: value.maxResults, zone: value.zone, language: value.language };
}
async function readSettings(path) {
  let text;
  try { text = await readFile(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return { settings: { ...DEFAULT_SETTINGS }, revision: 'absent' }; throw error; }
  if (Buffer.byteLength(text) > 16384) throw new Error('设置文件过大');
  return { settings: validateSettings(JSON.parse(text)), revision: createHash('sha256').update(text).digest('hex') };
}
export async function loadSettings(path = settingsPath()) { return (await readSettings(path)).settings; }
export function applySearchDefaults(request, settings) {
  return {
    ...request,
    ...(request.maxResults === undefined && settings.maxResults !== null ? { maxResults: settings.maxResults } : {}),
    ...(request.zone === undefined && settings.zone !== 'auto' ? { zone: settings.zone } : {}),
    ...(request.language === undefined && settings.language !== '' ? { language: settings.language } : {}),
  };
}
async function saveSettings(settings, path) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = join(dirname(path), `.settings-${randomUUID()}.tmp`);
  let file, owned = false;
  try {
    file = await open(tmp, 'wx', 0o600); owned = true;
    await file.writeFile(`${JSON.stringify(settings, null, 2)}\n`, 'utf8');
    await file.close(); file = undefined;
    await rename(tmp, path); owned = false;
  } finally {
    if (file) await file.close().catch(() => {});
    if (owned) await unlink(tmp).catch(() => {});
  }
}
export function settingsHandler(path = settingsPath(), hostConfig) {
  let writes = Promise.resolve();
  const response = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
  return async request => {
    try {
      if (request.method === 'GET') { await writes; return response(200, { ok: true, ...await readSettings(path), ...(hostConfig ? { hostConfig } : {}) }); }
      if (request.method !== 'POST') return response(405, { ok: false, error: '不支持的请求方法' });
      const origin = request.headers.get('origin');
      if ((origin && origin !== new URL(request.url).origin) || request.headers.get('sec-fetch-site') === 'cross-site') return response(403, { ok: false, error: '禁止跨站请求' });
      if (!/^application\/json(?:\s*;|\s*$)/i.test(request.headers.get('content-type') || '')) return response(415, { ok: false, error: '请求必须使用 JSON' });
      const text = await request.text();
      if (Buffer.byteLength(text) > 16384) return response(413, { ok: false, error: '设置内容过大' });
      let body;
      try { body = JSON.parse(text); } catch { return response(400, { ok: false, error: '请求体不是有效 JSON' }); }
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 2 || !Object.hasOwn(body, 'settings') || typeof body.revision !== 'string' || body.revision.length > 64) return response(400, { ok: false, error: '无效的设置请求，请刷新页面' });
      let settings;
      try { settings = validateSettings(body.settings); } catch (error) { return response(400, { ok: false, error: error.message }); }
      const operation = writes.then(async () => {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        const db = new DatabaseSync(`${path}.lock.sqlite`);
        try {
          try { db.exec('BEGIN IMMEDIATE'); } catch (error) { if (error.errcode === 5 || error.errcode === 6) return null; throw error; }
          const current = await readSettings(path);
          if (current.revision !== body.revision) return null;
          await saveSettings(settings, path);
          return await readSettings(path);
        } finally { if (db.isTransaction) db.exec('ROLLBACK'); db.close(); }
      });
      writes = operation.catch(() => {});
      const saved = await operation;
      return saved ? response(200, { ok: true, ...saved }) : response(409, { ok: false, error: '设置已被其他窗口或 Host 修改，请重新加载后再保存' });
    } catch { return response(500, { ok: false, error: '设置读取或保存失败，请检查本地设置文件' }); }
  };
}
