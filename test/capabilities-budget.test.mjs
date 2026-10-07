import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { SEARCH_FOLLOWTHROUGH_FOOTER } from '../lib/followthrough.js';
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === '@deepseek-ai/dsh-tools') return { url: 'data:text/javascript,export const defineTool = tool => tool;', shortCircuit: true };
  return next(specifier, context);
} });
const { registerCapabilitiesTool, formatDomains, formatSubDomains } = await import('../lib/tools/capabilities.js');
hooks.deregister();

function capture(client, budget) {
  let tool;
  registerCapabilitiesTool({ tools: { register: value => { tool = value; } } }, client, budget);
  return tool;
}
function assertBounded(text, budget, truncated = true) {
  assert(text.length <= budget, `catalog render ${text.length} exceeds ${budget}`);
  if (budget >= 500) {
    assert.match(text, /untrusted/i);
    assert(text.endsWith(SEARCH_FOLLOWTHROUGH_FOOTER));
    if (truncated) assert.match(text, /truncated/i);
  }
}
function detailed(description = 'Short definition') {
  const params = Object.create(null);
  params.later = { description: 'Later parameter', required: false, sortOrder: 2 };
  params.__proto__ = { description: 'Declared prototype-named parameter', required: true, sortOrder: 1 };
  return { domains: [{ domain: 'business', description,
    subDomains: [{ subDomain: 'company', description: 'Company search', params }] }] };
}

test('normal detailed catalog keeps declared identifiers, ordering, __proto__, signal and false truncation', async () => {
  const response = detailed();
  const signal = new AbortController().signal;
  let sent;
  const tool = capture({ getSubDomains: async (domains, received) => {
    assert.equal(received, signal);
    sent = domains;
    return response;
  } }, 12_000);
  const domains = [' business ', 'business'];
  const value = await tool.execute({ domains }, { signal });
  assert.deepEqual(sent, ['business']);
  assert.deepEqual(domains, [' business ', 'business']);
  assert.equal(value.truncated, false);
  assert.equal(tool.output.presentationMeta({}, value).truncated, false);
  assert(Object.hasOwn(value.domains[0].subDomains[0].params, '__proto__'));
  const text = tool.output.render({}, value)[0].text;
  assertBounded(text, 12_000, false);
  assert.match(text, /__proto__ \(required\): Declared prototype-named parameter/);
  assert(text.indexOf('__proto__') < text.indexOf('later:'));
  assert.match(text, /Use the exact sub-domain/);
  assert(!/truncated/i.test(text));
});

test('normal top-level and empty catalogs do not report false truncation', async () => {
  for (const domains of [[], [{ domain: 'business', description: 'Business catalog', subDomainCount: 2 }]]) {
    const tool = capture({ listDomains: async () => ({ requestId: 'fixture-id', domains }) }, 12_000);
    const value = await tool.execute({}, {});
    assert.equal(value.kind, 'domains');
    assert.equal(value.truncated, false);
    assert.equal(tool.output.presentationMeta({}, value).truncated, false);
    assertBounded(tool.output.render({}, value)[0].text, 12_000, false);
  }
});

test('large request IDs, descriptions and many domains are bounded and any projection loss is visible', async () => {
  const response = { requestId: 'R'.repeat(250_000), domains: Array.from({ length: 5_000 }, (_, i) => ({
    domain: `domain_${i}`, description: 'D'.repeat(250_000), subDomainCount: 1,
  })) };
  const tool = capture({ listDomains: async () => response }, 12_000);
  const value = await tool.execute({}, {});
  assert.equal(value.truncated, true);
  assert.equal(tool.output.presentationMeta({}, value).truncated, true);
  assert(value.requestId.length <= 256);
  assert(value.domains.length < response.domains.length);
  assert(value.domains.every(domain => domain.description.length <= 2_000));
  assert(JSON.stringify(value).length < 30_000);
  assert.equal(response.requestId.length, 250_000);
  assert.equal(response.domains[0].description.length, 250_000);
  assertBounded(tool.output.render({}, value)[0].text, 12_000);
});

test('identifiers exceeding the projection budget are omitted explicitly rather than renamed', async () => {
  const huge = 'name_'.repeat(30_000);
  const top = capture({ listDomains: async () => ({ domains: [{ domain: huge, description: 'Fixture', subDomainCount: 1 }] }) }, 1_000);
  const topValue = await top.execute({}, {});
  assert.deepEqual(topValue.domains, []);
  assert.equal(topValue.truncated, true);
  const text = top.output.render({}, topValue)[0].text;
  assertBounded(text, 1_000);
  assert(!text.includes('No AnySearch domains are currently available'), 'clipped catalog is not an empty upstream catalog');
  const response = detailed();
  response.domains[0].subDomains[0].params = Object.create(null);
  response.domains[0].subDomains[0].params[huge] = { description: 'Fixture', required: true };
  const tool = capture({ getSubDomains: async () => response }, 1_000);
  const value = await tool.execute({ domains: ['business'] }, {});
  assert.deepEqual(Object.keys(value.domains[0].subDomains[0].params), []);
  assert.equal(value.truncated, true);
  assertBounded(tool.output.render({}, value)[0].text, 1_000);
  assert.equal(Object.keys(response.domains[0].subDomains[0].params)[0], huge);
});

test('renderers stop catalog traversal once the budget is exhausted instead of joining all fields', () => {
  const domains = [{ domain: 'first', description: 'D'.repeat(250_000), subDomainCount: 1 }];
  domains.push({ get domain() { throw new Error('unretained domain must not be visited'); } });
  assertBounded(formatDomains({ domains }, 500), 500);
  const params = Object.create(null);
  params.first = { description: 'D'.repeat(250_000), required: false };
  Object.defineProperty(params, 'unretained', { enumerable: true, get() {
    throw new Error('unretained parameter must not be visited');
  } });
  assertBounded(formatSubDomains({ domains: [{ domain: 'business', description: '',
    subDomains: [{ subDomain: 'company', description: '', params }] }] }, 500), 500);
});

test('all tiny budgets are hard caps with truthful execute and presentation flags', async () => {
  const response = detailed('D'.repeat(250_000));
  for (let budget = 1; budget <= 600; budget += 1) {
    const tool = capture({ getSubDomains: async () => response }, budget);
    const value = await tool.execute({ domains: ['business'] }, {});
    assert.equal(value.truncated, true, `value flag at ${budget}`);
    assert.equal(tool.output.presentationMeta({}, value).truncated, true);
    assertBounded(tool.output.render({}, value)[0].text, budget);
    assertBounded(formatDomains({ domains: [{ domain: 'fixture', description: 'D'.repeat(250_000), subDomainCount: 2 }] }, budget), budget);
    assertBounded(formatSubDomains(response, budget), budget);
  }
});

test('default formatter budgets include all safety notices, truncation note and followthrough', () => {
  const giant = 'D'.repeat(250_000);
  assertBounded(formatDomains({ requestId: giant, domains: [{ domain: giant, description: giant, subDomainCount: 1 }] }), 12_000);
  assertBounded(formatSubDomains(detailed(giant)), 12_000);
});

test('render-only truncation omits whole identifiers and keeps structured declarations unchanged', async () => {
  const name = 'identifier_start_' + 'X'.repeat(600);
  const top = capture({ listDomains: async () => ({ domains: [{ domain: name, description: 'x', subDomainCount: 1 }] }) }, 800);
  const value = await top.execute({}, {});
  assert.equal(value.domains[0].domain, name);
  assert.equal(value.truncated, true);
  const text = top.output.render({}, value)[0].text;
  assertBounded(text, 800);
  assert(!text.includes('identifier_start_'), 'render must omit, not cut, a declared domain identifier');
  const response = detailed();
  const param = 'parameter_start_' + 'X'.repeat(800);
  response.domains[0].subDomains[0].params = { [param]: { description: 'x', required: true } };
  const tool = capture({ getSubDomains: async () => response }, 1_200);
  const detailedValue = await tool.execute({ domains: ['business'] }, {});
  assert(Object.hasOwn(detailedValue.domains[0].subDomains[0].params, param));
  assert.equal(detailedValue.truncated, true);
  const detailedText = tool.output.render({}, detailedValue)[0].text;
  assertBounded(detailedText, 1_200);
  assert(!detailedText.includes('parameter_start_'), 'render must omit, not cut, a declared parameter identifier');
});

test('many tiny parameter nodes are bounded, not merely giant descriptions', async () => {
  const response = detailed();
  const params = Object.create(null);
  for (let i = 0; i < 10_000; i += 1) params[`param_${i}`] = { description: '', required: i === 0 };
  response.domains[0].subDomains[0].params = params;
  const tool = capture({ getSubDomains: async () => response }, 12_000);
  const value = await tool.execute({ domains: ['business'] }, {});
  const retained = Object.keys(value.domains[0].subDomains[0].params);
  assert(retained.length < 200);
  assert.equal(value.domains[0].subDomains[0].params.param_0.required, true);
  assert.equal(value.truncated, true);
  assert(JSON.stringify(value).length < 30_000);
  assertBounded(tool.output.render({}, value)[0].text, 12_000);
  assert.equal(Object.keys(params).length, 10_000);
});

test('response failures and cancellation remain explicit rather than becoming empty catalogs', async () => {
  const failure = Object.assign(new Error('synthetic cancellation'), { kind: 'aborted' });
  const tool = capture({ listDomains: async () => { throw failure; }, getSubDomains: async () => { throw failure; } }, 12_000);
  await assert.rejects(tool.execute({}, {}), error => error === failure);
  await assert.rejects(tool.execute({ domains: ['business'] }, {}), error => error === failure);
});

test('both output schema variants declare the truthful truncation boolean', () => {
  const tool = capture({}, 12_000);
  for (const variant of tool.output.schema.oneOf) {
    assert.equal(variant.properties.truncated.type, 'boolean');
    assert.equal(variant.properties.truncated.required, true);
  }
});
