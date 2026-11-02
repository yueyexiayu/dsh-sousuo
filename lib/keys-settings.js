import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseKeys } from './keys.js';

const limit = 16384;
async function readKeys(path) {
  let text;
  try { text = await readFile(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return { text: '', keys: [], revision: 'absent' }; throw error; }
  if (Buffer.byteLength(text) > limit) throw new Error('key file too large');
  return { text, keys: parseKeys(text), revision: createHash('sha256').update(text).digest('hex') };
}
async function replaceKeys(path, text) {
  const temporary = join(dirname(path), `.keys-${randomUUID()}.tmp`);
  let file, owned = false;
  try {
    file = await open(temporary, 'wx', 0o600); owned = true;
    await file.writeFile(text, 'utf8');
    await file.sync(); await file.close(); file = undefined;
    await rename(temporary, path); owned = false;
  } finally {
    if (file) await file.close().catch(() => {});
    if (owned) await unlink(temporary).catch(() => {});
  }
}
export function keysHandler(path, client) {
  let writes = Promise.resolve();
  const response = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
  const summary = data => ({ count: data.keys.length, revision: data.revision });
  return async request => {
    try {
      if (request.method === 'GET') { await writes; return response(200, { ok: true, ...summary(await readKeys(path)) }); }
      if (request.method !== 'POST') return response(405, { ok: false, error: '不支持的请求方法' });
      const origin = request.headers.get('origin');
      if ((origin && origin !== new URL(request.url).origin) || request.headers.get('sec-fetch-site') === 'cross-site') return response(403, { ok: false, error: '禁止跨站请求' });
      if (!/^application\/json(?:\s*;|\s*$)/i.test(request.headers.get('content-type') || '')) return response(415, { ok: false, error: '请求必须使用 JSON' });
      const text = await request.text();
      if (Buffer.byteLength(text) > limit) return response(413, { ok: false, error: '请求内容过大' });
      let body;
      try { body = JSON.parse(text); } catch { return response(400, { ok: false, error: '请求格式无效' }); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return response(400, { ok: false, error: '请求格式无效' });
      if (body.action === 'test' && Object.keys(body).length === 1) {
        await writes;
        try { await client.search({ query: 'DeepSeek official website', maxResults: 1 }); return response(200, { ok: true, message: '连接成功，搜索请求已返回。' }); }
        catch (error) { return response(200, { ok: false, error: `连接失败${Number.isInteger(error?.httpStatus) ? `（HTTP ${error.httpStatus}）` : ''}，请检查 Key、网络和服务状态。` }); }
      }
      if (!['add', 'delete'].includes(body.action) || typeof body.revision !== 'string' || Object.keys(body).length !== 3) return response(400, { ok: false, error: '请求格式无效' });
      if (body.action === 'add' && (typeof body.key !== 'string' || body.key.length > 4096 || /[\u0000-\u001f\u007f-\u009f]/u.test(body.key) || !body.key.trim() || body.key.trim().startsWith('#'))) return response(400, { ok: false, error: '请输入单行有效 Key' });
      if (body.action === 'delete' && (!Number.isSafeInteger(body.index) || body.index < 0)) return response(400, { ok: false, error: 'Key 编号无效' });
      const operation = writes.then(async () => {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        const db = new DatabaseSync(`${path}.lock.sqlite`);
        try {
          try { db.exec('BEGIN IMMEDIATE'); } catch (error) { if (error.errcode === 5 || error.errcode === 6) return { status: 409, error: 'Key 正在被其他窗口修改，请刷新后重试' }; throw error; }
          const current = await readKeys(path);
          if (current.revision !== body.revision) return { status: 409, error: 'Key 已在其他位置更改，请刷新后重试' };
          let next;
          if (body.action === 'add') {
            const key = body.key.trim();
            if (current.keys.includes(key)) return { status: 400, error: '该 Key 已存在' };
            next = `${current.text}${current.text && !current.text.endsWith('\n') ? '\n' : ''}${key}\n`;
          } else {
            if (body.index >= current.keys.length) return { status: 400, error: 'Key 编号无效' };
            let index = 0;
            next = current.text.split(/(?<=\n)/u).filter(line => {
              const item = line.replace(/\r?\n$/u, '').trim();
              return !item || item.startsWith('#') || index++ !== body.index;
            }).join('');
          }
          if (Buffer.byteLength(next) > limit) return { status: 400, error: 'Key 文件已达到大小上限' };
          await replaceKeys(path, next);
          return { status: 200, ...summary(await readKeys(path)) };
        } finally { if (db.isTransaction) db.exec('ROLLBACK'); db.close(); }
      });
      writes = operation.catch(() => {});
      const result = await operation;
      return response(result.status, result.error ? { ok: false, error: result.error } : { ok: true, count: result.count, revision: result.revision });
    } catch { return response(500, { ok: false, error: 'Key 操作失败，请检查本地文件权限和格式' }); }
  };
}
