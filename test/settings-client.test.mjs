import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const code = await readFile(new URL('../lib/settings-client.js', import.meta.url), 'utf8');
const defaults = { maxResults: null, zone: 'auto', language: '' };
function harness(handler) {
  let plugin, component, tree, dirty = true, cursor = 0;
  const hooks = [], effects = [], calls = [];
  const React = {
    createElement(type, props, ...children) { return { type, props: { ...props, children: children.flat(Infinity) } }; },
    useState(initial) { const i = cursor++; if (!(i in hooks)) hooks[i] = initial; return [hooks[i], value => { hooks[i] = typeof value === 'function' ? value(hooks[i]) : value; dirty = true; }]; },
    useEffect(effect) { const i = cursor++; if (!(i in hooks)) effects.push(() => { hooks[i] = effect(); }); },
  };
  vm.runInNewContext(code, { window: { __ModuleLoader__: { load(spec) { assert.equal(spec.id, 'sousuo'); plugin = spec.factory(name => { assert.equal(name, 'react'); return React; }); } } }, AbortController, fetch: async (url, options) => {
    const call = { url, method: options.method ?? 'GET', body: options.body && JSON.parse(options.body) }; calls.push(call);
    const result = await handler(call); return { ok: result.status < 400, status: result.status, json: async () => result.body };
  } });
  assert.deepEqual(Array.from(plugin.inject), ['slots']);
  plugin.apply({ slots: { inject(name, callback) { assert.equal(name, 'plugins.bundle.config'); callback(); }, register(options, value) { assert.equal(options.key, 'sousuo'); component = value; } } });
  function render() { dirty = false; cursor = 0; tree = component(); while (effects.length) effects.shift()(); }
  function nodes(node = tree) { if (!node || typeof node !== 'object') return []; return [node, ...(node.props.children || []).flatMap(nodes)]; }
  function text(node) { return typeof node === 'object' && node !== null ? (node.props.children || []).map(text).join('') : String(node ?? ''); }
  function label(name) { const item = nodes().find(node => node.type === 'label' && text(node).startsWith(name)); assert.ok(item, name); return item.props.children.find(child => child && typeof child === 'object'); }
  function button(name) { const item = nodes().find(node => node.type === 'button' && text(node) === name); assert.ok(item, name); return item; }
  async function settle() { for (let i = 0; i < 5; i++) { if (dirty) render(); await new Promise(resolve => setImmediate(resolve)); } if (dirty) render(); }
  return { calls, settle, label, button, text: () => text(tree), async change(name, value) { label(name).props.onChange({ target: { value } }); await settle(); }, async click(name) { await button(name).props.onClick(); await settle(); }, async submit() { await nodes().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); await settle(); } };
}
const success = settings => ({ status: 200, body: { ok: true, settings, revision: 'r1' } });

test('loads defaults, saves explicit values with revision, and can clear them', async () => {
  const app = harness(call => success(call.body?.settings ?? defaults));
  await app.settle();
  assert.deepEqual(app.calls.map(x => [x.method, x.url]), [['GET', '/api/sousuo/settings']]);
  assert.equal(app.label('默认结果数量').props.value, '');
  assert.equal(app.button('保存设置').props.disabled, true);
  await app.change('默认结果数量', '12'); await app.change('默认区域', 'intl'); await app.change('默认语言', 'en-US');
  await app.submit();
  assert.deepEqual(app.calls[1].body, { settings: { maxResults: 12, zone: 'intl', language: 'en-US' }, revision: 'r1' });
  assert.match(app.text(), /默认设置已保存/);
  await app.change('默认结果数量', ''); await app.change('默认语言', ''); await app.submit();
  assert.equal(app.calls[2].body.settings.maxResults, null);
  assert.equal(app.calls[2].body.settings.language, '');
});

test('shows read-only effective host configuration and explains native result limits', async () => {
  const hostConfig = { baseURL: 'https://search.example/v1', keysPath: '/profile/keys', statePath: '/profile/state.json', maxRenderedContentChars: 10000, advancedTools: false };
  const app = harness(call => ({ status: 200, body: { ok: true, settings: call.body?.settings ?? defaults, revision: 'r1', ...(call.method === 'GET' ? { hostConfig } : {}) } }));
  await app.settle();
  for (const value of ['https://search.example/v1', '/profile/keys', '/profile/state.json', '10000', '关闭']) assert.ok(app.text().includes(value), value);
  assert.match(app.text(), /profile／Host 配置及其默认值.*重启/);
  assert.match(app.text(), /请求数量.*官方结果渲染限制/);
  await app.change('默认区域', 'cn'); await app.submit();
  assert.deepEqual(Object.keys(app.calls[1].body).sort(), ['revision', 'settings']);
  assert.ok(app.text().includes('/profile/keys'));
});

test('absent host configuration is reported as unavailable', async () => {
  const app = harness(() => success(defaults)); await app.settle();
  assert.match(app.text(), /Host 配置不可用/);
});

test('undo restores saved settings and invalid counts cannot be submitted', async () => {
  const app = harness(() => success(defaults)); await app.settle();
  await app.change('默认区域', 'cn'); await app.click('撤销更改');
  assert.equal(app.label('默认区域').props.value, 'auto');
  await app.change('默认结果数量', '21'); await app.submit();
  assert.match(app.text(), /1–20 的整数/); assert.equal(app.calls.length, 1);
});

test('conflicts preserve the draft and require an explicit reload', async () => {
  let gets = 0;
  const app = harness(call => call.method === 'POST' ? { status: 409, body: { ok: false, error: 'conflict' } } : success(++gets === 1 ? defaults : { maxResults: 5, zone: 'cn', language: 'zh-CN' }));
  await app.settle(); await app.change('默认语言', 'en-US'); await app.submit();
  assert.match(app.text(), /丢弃当前更改/); assert.equal(app.label('默认语言').props.value, 'en-US');
  assert.equal(app.button('保存设置').props.disabled, true);
  await app.click('重新加载设置');
  assert.equal(app.label('默认语言').props.value, 'zh-CN'); assert.equal(app.label('默认结果数量').props.value, 5);
});

test('load and save errors are visible and load failure can be retried', async () => {
  let count = 0;
  const app = harness(call => { if (call.method === 'POST') return { status: 400, body: { ok: false, error: '语言格式错误' } }; return ++count === 1 ? { status: 500, body: { ok: false, error: '读取失败' } } : success(defaults); });
  await app.settle(); assert.match(app.text(), /读取失败/);
  await app.click('重新加载设置'); await app.change('默认语言', 'bad tag'); await app.submit();
  assert.match(app.text(), /语言格式错误/); assert.equal(app.label('默认语言').props.value, 'bad tag');
});
