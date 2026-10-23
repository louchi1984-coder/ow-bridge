import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { prepare, decode, completion, sendSSE } from '../src/protocol.js';
import { mergeModels, syncModels, OWNER } from '../src/sync.js';
import { freeModels, Backend } from '../src/backend.js';
import { createServer } from '../src/server.js';

const models = [{ id: 'opencode/test-free', name: 'Test', context: 1000, output: 500 }];
const tools = [{ type: 'function', function: { name: 'write_file', description: 'Write text', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } }];
const body = { model: models[0].id, messages: [{ role: 'user', content: 'Write a file' }], tools };

test('message history preserves roles and tool result IDs, rejects image loss', () => {
  const messages = [...body.messages, { role: 'assistant', content: null, tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'write_file', arguments: '{"path":"a"}' } }] }, { role: 'tool', tool_call_id: 'call_a', content: 'done' }];
  const request = prepare({ ...body, messages }, models);
  assert.equal(JSON.parse(request.text)[2].tool_call_id, 'call_a');
  assert.throws(() => prepare({ ...body, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] }] }, models), /does not declare image input/);
});
test('tool calls validated; none, forced and required are enforced', () => {
  const call = JSON.stringify({ content: '', calls: [{ name: 'write_file', arguments: { path: 'x' } }] });
  assert.equal(decode(call, prepare(body, models)).tool_calls[0].function.name, 'write_file');
  assert.throws(() => decode(call, prepare({ ...body, tool_choice: 'none' }, models)), /none/);
  assert.throws(() => decode('{"content":"done","calls":[]}', prepare({ ...body, tool_choice: 'required' }, models)), /required/);
  assert.throws(() => decode(call.replace('write_file', 'bash'), prepare(body, models)), /unlisted/);
  assert.equal(decode(call.replace('{"path":"x"}', '{}'), prepare(body, models)).tool_calls[0].function.arguments, '{}');
  assert.throws(() => prepare({ ...body, model: 'opencode/paid' }, models), /available free/);
  assert.throws(() => decode('not JSON', prepare(body, models)), /valid bridge/);
});
test('SSE sends structured calls without leaking envelope and includes usage', () => {
  let output = '';
  const message = decode('{"content":"","calls":[{"name":"write_file","arguments":{"path":"x"}}]}', prepare(body, models));
  sendSSE({ write: s => { output += s; }, end: s => { output += s; } }, completion(body.model, message, { input: 4, output: 2 }), true);
  const events = output.split('\n\n').filter(x => x.startsWith('data: {')).map(x => JSON.parse(x.slice(6)));
  assert.ok(events.some(e => e.choices?.[0]?.delta?.tool_calls));
  assert.ok(!events.some(e => e.choices?.[0]?.delta?.content?.includes('calls')));
  assert.equal(events.at(-1).usage.total_tokens, 6);
  assert.ok(output.endsWith('data: [DONE]\n\n'));
});
test('free discovery uses prices, not names; rejects unknown prices and paid output', () => {
  const model = cost => ({ cost, capabilities: { toolcall: true } });
  assert.deepEqual(freeModels({ all: [{ id: 'opencode', models: {
    'big-pickle': model({ input: 0, output: 0 }),
    'bad-free': model({ input: 0, output: 1 }),
    'unknown-free': model(undefined),
  } }] }).map(m => m.id), ['opencode/big-pickle']);
});
test('sync preserves unowned entries and object metadata, removes owned stale entries', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'buddy-test-'));
  const file = path.join(root, 'models.json');
  const user = { id: 'personal', apiKey: 'private', url: 'existing' };
  const old = { models: [user, { id: 'opencode/old', buddyBridgeOwner: OWNER }], availableModels: ['personal', 'opencode/old'], other: true };
  await fs.writeFile(file, JSON.stringify(old));
  const staleLock = `${file}.buddy-bridge.lock`;
  await fs.writeFile(staleLock, 'stale');
  const staleTime = new Date(Date.now() - 10 * 60 * 1000);
  await fs.utimes(staleLock, staleTime, staleTime);
  try {
    const result = await syncModels(file, models, 'http://127.0.0.1:41980/v1/chat/completions', 'local-key');
    assert.equal(result.changed, true);
    assert.deepEqual(JSON.parse(await fs.readFile(result.backup, 'utf8')), old);
    const merged = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.deepEqual(merged.models[0], user); assert.equal(merged.other, true);
    assert.deepEqual(merged.availableModels, ['personal', 'OC · Test']);
    assert.equal((await syncModels(file, models, 'http://127.0.0.1:41980/v1/chat/completions', 'local-key')).changed, false);
    await assert.rejects(syncModels(file, [], 'x', 'x'), /Empty model/);
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), merged);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test('manual ID collision remains untouched; malformed config is not reset', () => {
  const custom = { id: models[0].id, apiKey: 'mine' };
  assert.deepEqual(mergeModels([custom], models, 'x', 'y'), [custom]);
  assert.throws(() => mergeModels({ unknown: true }, models, 'x', 'y'), /Unrecognized/);
});

async function listen(server) {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${server.address().port}`;
}
test('backend requires native approval and cleans sessions on success and model failure', async () => {
  const events = []; let fail = false;
  const fake = http.createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const data = text ? JSON.parse(text) : null;
    events.push({ method: req.method, url: req.url, data });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/permission') return res.end('[]');
    if (req.url === '/session') return res.end('{"id":"ses_test"}');
    if (req.url.endsWith('/message')) return res.end(JSON.stringify(fail ? { info: { error: { data: { message: 'FreeTierError', statusCode: 403 } } } } : { info: { finish: 'stop' }, parts: [{ type: 'text', text: '{"content":"OK","calls":[]}' }] }));
    res.end('true');
  });
  const backend = new Backend(await listen(fake), 'test');
  try {
    await backend.complete(prepare(body, models));
    assert.equal(events.find(e => e.url.endsWith('/message')).data.agent, 'buddy-bridge');
    assert.equal(events.find(e => e.url.endsWith('/message')).data.tools, undefined);
    assert.deepEqual(events.find(e => e.url === '/session').data.permission[0], { permission: '*', pattern: '*', action: 'ask' });
    assert.equal(events.at(-1).method, 'DELETE');
    fail = true;
    await assert.rejects(backend.complete(prepare(body, models)), /FreeTierError/);
    assert.equal(events.at(-2).url, '/session/ses_test/abort'); assert.equal(events.at(-1).method, 'DELETE');
  } finally { fake.closeAllConnections(); fake.close(); }
});
test('HTTP authenticates local clients, rejects origins, supports SSE and model selection', async () => {
  let selected;
  const server = createServer({ key: 'test', backend: { complete: async r => { selected = r.model.id; return completion(r.model.id, { role: 'assistant', content: 'OK' }); } }, getModels: () => models, refresh: async () => ({}), status: () => ({ phase: 'ready' }) });
  const base = await listen(server);
  const headers = { Authorization: 'Bearer test', 'Content-Type': 'application/json' };
  try {
    assert.equal((await fetch(base + '/v1/models')).status, 401);
    assert.equal((await fetch(base + '/v1/models', { headers: { ...headers, Origin: 'https://example.com' } })).status, 403);
    assert.equal((await (await fetch(base + '/v1/models', { headers })).json()).data[0].id, 'OC · Test');
    const response = await fetch(base + '/v1/chat/completions', { method: 'POST', headers, body: JSON.stringify({ ...body, stream: true }) });
    assert.ok((await response.text()).includes('[DONE]')); assert.equal(selected, body.model);
  } finally { server.closeAllConnections(); server.close(); }
});

test('SSE starts on real upstream content while buffering the answer and tools', { timeout: 5000 }, async () => {
  let activity, finish;
  const events = [];
  const pending = new Promise(resolve => { finish = resolve; });
  const server = createServer({ key: 'test', getModels: () => models,
    backend: { complete: async (request, signal, meta) => {
      activity = meta.activity;
      activity({ status: 'busy' });
      return pending;
    } }, onActivity: event => events.push(event), status: () => ({}) });
  const base = await listen(server);
  try {
    const response = await fetch(base + '/v1/chat/completions', { method: 'POST',
      headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, model: 'OC · Test', stream: true, stream_options: { include_usage: true } }) });
    const reader = response.body.getReader();
    const read = async () => new TextDecoder().decode((await reader.read()).value);
    assert.equal(await read(), ': validating model response before emission\n\n', 'Busy alone does not signal model output');
    activity({ status: 'receiving', content: true });
    const first = JSON.parse((await read()).slice(6).trim());
    assert.deepEqual(first.choices, [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]);
    activity({ status: 'receiving', content: true });
    const message = { role: 'assistant', content: 'Ready', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'write_file', arguments: '{"path":"a"}' } }] };
    finish(completion(body.model, message, { input: 10, output: 5 }));
    let rest = '';
    for (;;) { const { value, done } = await reader.read(); if (done) break; rest += new TextDecoder().decode(value); }
    const chunks = rest.split('\n\n').filter(x => x.startsWith('data: ') && !x.includes('[DONE]')).map(x => JSON.parse(x.slice(6)));
    assert.ok(chunks.every(x => x.id === first.id && x.created === first.created && x.model === 'OC · Test'));
    assert.ok(chunks.every(x => !x.choices[0]?.delta.role), 'The role chunk is emitted only once');
    assert.equal(chunks[0].choices[0].delta.content, message.content);
    assert.deepEqual(chunks[1].choices[0].delta.tool_calls, message.tool_calls.map((call, index) => ({ index, ...call })));
    assert.equal(chunks[2].choices[0].finish_reason, 'tool_calls');
    assert.equal(chunks[3].usage.total_tokens, 15);
    assert.equal(rest.match(/\[DONE\]/g).length, 1);
    assert.equal(events.length, 3, 'Existing activity reporting is preserved');
  } finally { finish(completion(body.model, { role: 'assistant', content: '' })); server.closeAllConnections(); server.close(); }
});

test('a native approval without a call ID is refused by name and never approved', async () => {
  const events = []; const replies = []; let pending = false, held;
  const fake = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    events.push(`${req.method} ${req.url}`);
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/session') return res.end('{"id":"ses_blocked"}');
    if (req.url === '/permission') return res.end(JSON.stringify(pending ? [{ id: 'per_blocked', sessionID: 'ses_blocked', permission: 'bash' }] : []));
    if (req.url.endsWith('/reply')) {
      replies.push(JSON.parse(raw)); pending = false;
      if (held) { const answered = held; held = null; answered.end('{"info":{"structured":{"content":"OK","calls":[]}},"parts":[]}'); }
      return res.end('true');
    }
    if (req.url.endsWith('/message')) { pending = true; held = res; return; }
    res.end('true');
  });
  const backend = new Backend(await listen(fake), 'test', 1500);
  try {
    const result = await backend.complete(prepare(body, models));
    assert.equal(result.choices[0].message.content, 'OK', 'A refusal must not abort the whole request');
    assert.equal(replies.length, 1);
    assert.equal(replies[0].reply, 'reject', 'No native action is ever approved');
    assert.match(replies[0].message, /"bash"/, 'The refusal names the tool');
    assert.ok(events.includes('DELETE /session/ses_blocked'));
    assert.ok(!events.some(e => /approve|allow/.test(e)));
  } finally { fake.closeAllConnections(); fake.close(); }
});

test('a native action is rejected before a corrected structured response is accepted', async () => {
  let waiting, reply;
  const fake = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/session') return res.end('{"id":"ses_correct"}');
    if (req.url === '/permission') return res.end(JSON.stringify(waiting ? [{ id: 'per_correct', sessionID: 'ses_correct', tool: { callID: 'native_call' } }] : []));
    if (req.url === '/session/ses_correct/message' && req.method === 'GET') return res.end(JSON.stringify([{ parts: [
      { type: 'tool', callID: 'native_call', tool: 'glob', state: { status: 'running', input: { pattern: '**/*' } } }] }]));
    if (req.url.endsWith('/message')) { waiting = res; return; }
    if (req.url.endsWith('/reply')) {
      reply = JSON.parse(raw);
      waiting.end(JSON.stringify({ info: { structured: { content: 'OK', calls: [] } }, parts: [{ type: 'tool', tool: 'write', callID: 'native_call', state: { status: 'error' } }, { type: 'tool', tool: 'StructuredOutput' }] }));
      waiting = null;
    }
    res.end('true');
  });
  const backend = new Backend(await listen(fake), 'test', 2000);
  try {
    const result = await backend.complete(prepare(body, models));
    assert.equal(reply.reply, 'reject');
    assert.equal(result.choices[0].message.content, 'OK');
  } finally { fake.closeAllConnections(); fake.close(); }
});

test('quota, throttling, access and unknown errors remain distinct', async () => {
  const { modelResult } = await import('../src/model-status.js');
  assert.equal(modelResult(false, 'insufficient_quota', 429).category, 'quota');
  assert.equal(modelResult(false, 'Too many requests', 429).category, 'rate_limit');
  assert.equal(modelResult(false, 'Free tier only within OpenCode', 403).category, 'access');
  assert.equal(modelResult(false, 'Model probe timed out').category, 'timeout');
  assert.equal(modelResult(false, 'Missing file_path', 502).category, 'error');
  assert.equal(modelResult(true).category, 'available');
  const catalog = freeModels({ all: [{ id: 'opencode', models: { exhausted: { cost: { input: 0, output: 0 }, capabilities: { toolcall: true }, remaining: 0 } } }] });
  assert.equal(catalog.length, 1, 'An exhausted free model stays in the catalog');
});

test('withdrawing every managed model preserves user models and metadata', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'buddy-withdraw-'));
  const file = path.join(root, 'models.json');
  const old = { models: [{ id: 'personal' }, { id: models[0].id, buddyBridgeOwner: OWNER }], availableModels: ['personal', models[0].id], keep: true };
  await fs.writeFile(file, JSON.stringify(old));
  try {
    await syncModels(file, [], 'local', 'key', { allowEmpty: true });
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { models: [{ id: 'personal' }], availableModels: ['personal'], keep: true });
    await syncModels(file, models, 'local', 'key', { allowEmpty: true });
    assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).models.length, 2);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('failed models disappear from API and cached callers cannot execute them', async () => {
  let published = models, calls = 0, recorded = 0;
  const server = createServer({ key: 'test', getModels: () => published,
    backend: { complete: async () => { calls++; throw new Error('insufficient_quota'); } },
    onResult: async (_, ok) => { assert.equal(ok, false); recorded++; published = []; }, status: () => ({}) });
  const base = await listen(server);
  const headers = { Authorization: 'Bearer test', 'Content-Type': 'application/json' };
  const request = () => fetch(base + '/v1/chat/completions', { method: 'POST', headers, body: JSON.stringify(body) });
  try {
    assert.equal((await request()).status, 502);
    assert.deepEqual((await (await fetch(base + '/v1/models', { headers })).json()).data, []);
    assert.equal((await request()).status, 400);
    assert.equal(calls, 1); assert.equal(recorded, 1);
    assert.equal(models.length, 1, 'UI discovery catalog is retained');
  } finally { server.closeAllConnections(); server.close(); }
});

test('response timings cover completed and failed upstream requests', async () => {
  let fail = false;
  const recorded = [];
  const server = createServer({ key: 'test', getModels: () => models,
    backend: { complete: async () => {
      await new Promise(resolve => setTimeout(resolve, 40));
      if (fail) throw new Error('timed out');
      return completion(body.model, { role: 'assistant', content: 'OK' });
    } },
    onResult: async (...args) => { recorded.push(args); }, status: () => ({}) });
  const base = await listen(server);
  const request = () => fetch(base + '/v1/chat/completions', { method: 'POST',
    headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    assert.equal((await request()).status, 200);
    fail = true;
    assert.equal((await request()).status, 502);
    assert.deepEqual(recorded.map(args => args[1]), [true, false]);
    for (const args of recorded) assert.ok(Number.isInteger(args[5]) && args[5] >= 30, 'Includes upstream wait on both outcomes');
  } finally { server.closeAllConnections(); server.close(); }
});


test('short client IDs display once, route to upstream IDs and preserve manual collisions', () => {
  const entries = mergeModels([], models, 'local', 'key');
  assert.equal(entries[0].id, 'OC · Test');
  assert.equal(entries[0].name, entries[0].id);
  assert.equal(prepare({ ...body, model: entries[0].id }, models).model.id, models[0].id);
  assert.throws(() => prepare({ ...body, model: entries[0].id }, []), /available free/);
  const manual = { id: entries[0].id, apiKey: 'mine' };
  assert.deepEqual(mergeModels([manual], models, 'local', 'key'), [manual]);
  const legacy = [{ id: models[0].id, buddyBridgeOwner: OWNER }];
  assert.deepEqual(mergeModels(legacy, models, 'local', 'key'), entries);
});


test('discovery preserves provider names for existing and newly added models', () => {
  const entry = name => ({ name, cost: { input: 0, output: 0 }, capabilities: { toolcall: true } });
  const discovered = freeModels({ all: [{ id: 'opencode', models: {
    'mimo-v2.6-flash-free': entry('MiMo-V2.6-Flash'),
    'future-model-free': entry('Future Model Preview'),
    'no-name': entry(undefined),
  } }] });
  assert.equal(discovered.find(m => m.id.endsWith('/mimo-v2.6-flash-free')).name, 'MiMo-V2.6-Flash');
  assert.equal(discovered.find(m => m.id.endsWith('/future-model-free')).name, 'Future Model Preview');
  assert.equal(discovered.find(m => m.id.endsWith('/no-name')).name, 'no-name');
});

test('chat-only models preserve text without structured formatting and reject tool requests', async () => {
  const chatModels = [{ ...models[0], chatOnly: true }];
  assert.throws(() => prepare(body, chatModels), /仅支持普通对话/);
  let sent;
  const backend = new Backend('http://unused', 'test');
  backend.request = async (route, method, data) => {
    if (route === '/session') return { id: 'chat' };
    if (route === '/permission') return [];
    if (route.endsWith('/message')) { sent = data; return { info: {}, parts: [{ type: 'text', text: 'Plain answer' }] }; }
    return true;
  };
  const result = await backend.complete(prepare({ model: models[0].id, messages: body.messages }, chatModels));
  assert.equal(sent.format, undefined);
  assert.equal(sent.agent, 'buddy-chat');
  assert.equal(result.choices[0].message.content, 'Plain answer');
  assert.equal(result.choices[0].message.tool_calls, undefined);
});

test('import fills capabilities and token limits from detected model metadata', () => {
  const result = mergeModels([{ id: 'personal' }], [{ ...models[0], chatOnly: true }], 'local', 'key');
  assert.equal(result[0].id, 'personal');
  assert.equal(result[1].supportsToolCall, false);
  assert.equal(result[1].supportsImages, false);
  assert.equal(result[1].supportsReasoning, false);
  assert.equal(result[1].maxInputTokens, 1000);
  assert.equal(result[1].maxOutputTokens, 500);
  assert.equal(mergeModels([], models, 'local', 'key')[0].supportsToolCall, true);
});


test('reasoning scan preserves variants; import advertises only mapped controls', () => {
  const discovered = freeModels({ all: [{ id: 'opencode', models: {
    test: { name: 'Test', cost: { input: 0, output: 0 }, capabilities: { reasoning: true },
      variants: { fast: { reasoningEffort: 'low' }, deep: { reasoningEffort: 'high' }, hidden: { reasoningEffort: 'max', disabled: true } } },
    default: { cost: { input: 0, output: 0 }, capabilities: { reasoning: true }, variants: {} },
  } }] });
  const model = discovered.find(m => m.id === 'opencode/test');
  assert.equal(model.reasoning, true);
  assert.deepEqual(model.variants.fast, { reasoningEffort: 'low' });
  const imported = mergeModels([], discovered, 'local', 'key');
  const entry = imported.find(m => m.name === 'OC · Test');
  assert.equal(entry.supportsReasoning, true);
  assert.equal(entry.onlyReasoning, true);
  assert.equal(entry.reasoning.canDisableThinking, false);
  assert.deepEqual(entry.reasoning.supportedEfforts, ['low', 'high']);
  const fixed = imported.find(m => m.name === 'OC · default');
  assert.equal(fixed.supportsReasoning, true);
  assert.equal(fixed.onlyReasoning, true);
  assert.deepEqual(fixed.reasoning, { supportedEfforts: [], canDisableThinking: false });
  const fixedModel = discovered.find(m => m.id === 'opencode/default');
  assert.equal(prepare({ model: fixedModel.id, messages: body.messages }, [fixedModel]).variant, undefined);
  const request = { model: model.id, messages: body.messages };
  assert.equal(prepare(request, [model]).variant, undefined);
  assert.equal(prepare({ ...request, reasoning_effort: 'high' }, [model]).variant, 'deep');
  for (const effort of ['none', 'max', 'toString', {}]) {
    assert.throws(() => prepare({ ...request, reasoning_effort: effort }, [model]), /reasoning effort/);
  }
});

test('WorkBuddy fallback effort uses the default mode for fixed-reasoning models', async () => {
  const backend = new Backend('http://unused', 'test');
  let sent;
  backend.request = async (route, method, payload) => {
    if (route === '/session') return { id: 'fixed-reasoning' };
    if (route.endsWith('/message')) {
      sent = payload;
      return { parts: [{ type: 'text', text: 'OK' }] };
    }
    return [];
  };
  const model = { ...models[0], chatOnly: true, reasoning: true, variants: {} };
  for (const effort of ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
    for (const field of [{ reasoning_effort: effort }, { reasoning: { effort } }]) {
      const request = prepare({ model: model.id, messages: body.messages, ...field }, [model]);
      await backend.complete(request);
      assert.equal(sent.variant, undefined, 'No unsupported variant is forwarded to OpenCode');
      assert.equal(prepare({ model: model.id, messages: body.messages, ...field }, [{ ...model, chatOnly: false }]).variant, undefined);
    }
  }
  for (const effort of ['none', 'invalid', {}])
    assert.throws(() => prepare({ model: model.id, messages: body.messages, reasoning_effort: effort }, [model]), /reasoning effort/);
  assert.throws(() => prepare({ model: model.id, messages: body.messages, reasoning_effort: 'high' }, [{ ...model, reasoning: false }]), /reasoning effort/);
});

test('reasoning selection reaches OpenCode for tool and plain chat requests', async () => {
  const backend = new Backend('http://unused', 'test');
  let sent;
  backend.request = async (route, method, data) => {
    if (route === '/session') return { id: 'reasoning' };
    if (route === '/permission') return [];
    if (route.endsWith('/message')) {
      sent = data;
      return { info: {}, parts: [{ type: 'text', text: data.agent === 'buddy-chat' ? 'OK' : '{"content":"OK","calls":[]}' }] };
    }
    return true;
  };
  for (const chatOnly of [false, true]) {
    const model = { ...models[0], chatOnly, reasoning: true, variants: { deep: { reasoningEffort: 'high' } } };
    await backend.complete(prepare({ model: model.id, messages: body.messages, reasoning: { effort: 'high' } }, [model]));
    assert.equal(sent.variant, 'deep');
  }
});

test('catalog capabilities and separate input/context limits drive import', () => {
  const discovered = freeModels({ all: [{ id: 'opencode', models: {
    vision: { name: 'Vision', cost: { input: 0, output: 0 }, limit: { context: 1000, input: 700, output: 300 }, capabilities: { input: { image: true } } },
    text: { cost: { input: 0, output: 0 }, limit: { context: 2000, output: 500 } },
  } }] });
  const vision = discovered.find(m => m.images);
  assert.equal(vision.context, 1000);
  assert.equal(vision.input, 700);
  const entries = mergeModels([], discovered, 'local', 'key');
  assert.equal(entries.find(m => m.name === 'OC · Vision').supportsImages, true);
  assert.equal(entries.find(m => m.name === 'OC · Vision').maxInputTokens, 700);
  assert.equal(entries.find(m => m.name === 'OC · text').maxInputTokens, 2000);
  assert.equal(entries.find(m => m.name === 'OC · text').supportsImages, false);
});

test('image attachments preserve history mapping in both tool and chat paths', async () => {
  const url = 'data:image/png;base64,iVBORw0KGgo=';
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'First' }, { type: 'image_url', image_url: { url } }] },
    { role: 'assistant', content: 'Seen' },
    { role: 'user', content: [{ type: 'image_url', image_url: { url } }, { type: 'text', text: 'Compare' }] },
  ];
  const backend = new Backend('http://unused', 'test');
  let sent;
  backend.request = async (route, method, data) => {
    if (route === '/session') return { id: 'vision' };
    if (route === '/permission') return [];
    if (route.endsWith('/message')) {
      sent = data;
      return { info: {}, parts: [{ type: 'text', text: data.agent === 'buddy-chat' ? 'OK' : '{"content":"OK","calls":[]}' }] };
    }
    return true;
  };
  for (const chatOnly of [true, false]) {
    const request = prepare({ model: models[0].id, messages }, [{ ...models[0], images: true, chatOnly }]);
    assert.equal(request.text.includes('base64'), false);
    assert.match(JSON.parse(request.text)[0].content, /message-1-image-2.png/);
    assert.match(JSON.parse(request.text)[2].content, /message-3-image-1.png/);
    await backend.complete(request);
    assert.deepEqual(sent.parts.slice(1), request.images);
    assert.equal(sent.parts[1].url, url);
    assert.match(sent.system, /Match each attachment filename/);
  }
  for (const bad of ['file:///etc/passwd', 'https://example.com/a.png', 'data:text/plain;base64,aGk=', 'data:image/png;base64,@@@']) {
    assert.throws(() => prepare({ model: models[0].id, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: bad } }] }] }, [{ ...models[0], images: true }]), /base64 data URLs/);
  }
});

test('a malformed response envelope gets one format-only correction before tools are emitted', async () => {
  const request = prepare(body, models);
  const malformed = { content: 123, calls: [{ name: 'write_file', arguments: { path: 'x' } }] };
  assert.throws(() => decode(JSON.stringify(malformed), request), /Invalid model response envelope/);
  const backend = new Backend('http://unused', 'test');
  const sent = [];
  backend.request = async (route, method, payload) => {
    if (route === '/session') return { id: 'repair' };
    if (route.endsWith('/message')) {
      sent.push(payload);
      return { info: { structured: sent.length === 1 ? malformed : { content: '', calls: malformed.calls } }, parts: [] };
    }
    return [];
  };
  const result = await backend.complete(request);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1].format, sent[0].format);
  assert.equal(sent[1].agent, 'buddy-bridge');
  assert.match(sent[1].parts[0].text, /No external tool has been executed/);
  assert.equal(result.choices[0].message.tool_calls.length, 1);
  assert.equal(result.choices[0].message.tool_calls[0].function.name, 'write_file');
});

test('a malformed call entry gets the same one format correction as a malformed envelope', async () => {
  const request = prepare(body, models);
  const backend = new Backend('http://unused', 'test');
  const sent = [];
  backend.request = async (route, method, payload) => {
    if (route === '/session') return { id: 'repair-call' };
    if (route.endsWith('/message')) {
      sent.push(payload);
      return sent.length === 1
        ? { info: { structured: { content: 'broken', calls: [null] } }, parts: [] }
        : { info: { structured: { content: '', calls: [{ name: 'write_file', arguments: { path: 'x' } }] } }, parts: [] };
    }
    return [];
  };
  const result = await backend.complete(request);
  assert.equal(sent.length, 2, 'One malformed call entry must not cost the whole turn');
  assert.match(sent[1].parts[0].text, /No external tool has been executed/);
  assert.equal(result.choices[0].message.tool_calls[0].function.name, 'write_file');
});

test('format correction is bounded and never retries native activity or truncation', async () => {
  for (const kind of ['malformed', 'unlisted', 'native', 'truncated']) {
    const backend = new Backend('http://unused', 'test');
    let calls = 0;
    backend.request = async route => {
      if (route === '/session') return { id: 'bounded' };
      if (route.endsWith('/message')) {
        calls++;
        if (kind === 'native') return { parts: [{ type: 'tool', tool: 'write' }] };
        if (kind === 'truncated') return { info: { finish: 'length' }, parts: [] };
        return { info: { structured: kind === 'malformed' ? {} : { content: '', calls: [{ name: 'unlisted', arguments: {} }] } }, parts: [] };
      }
      return [];
    };
    await assert.rejects(backend.complete(prepare(body, models)));
    // Every recoverable failure spends three rounds: the correction, the translation attempt (no
    // translator is configured here), then the explicit retry. Unexpected native activity still
    // fails immediately, because no retry can make an unapproved execution acceptable.
    assert.equal(calls, kind === 'native' ? 1 : 3);
  }
});


test('equivalent response formats normalize without inventing tools or arguments', () => {
  const request = prepare(body, models);
  const call = { name: 'write_file', arguments: { path: 'x' } };
  for (const value of [{ content: null, calls: [call] }, { calls: [call] },
    { content: '', calls: [{ ...call, arguments: JSON.stringify(call.arguments) }] },
    { role: 'assistant', content: null, tool_calls: [{ type: 'function', function: { ...call, arguments: JSON.stringify(call.arguments) } }] }]) {
    const result = decode(JSON.stringify(value), request);
    assert.equal(result.tool_calls[0].function.name, 'write_file');
    assert.deepEqual(JSON.parse(result.tool_calls[0].function.arguments), { path: 'x' });
  }
  for (const value of [{ content: 'hello' }, { content: 'hello', calls: null }])
    assert.deepEqual(decode(JSON.stringify(value), request), { role: 'assistant', content: 'hello' });
  for (const value of [{}, { content: '', calls: [], tool_calls: [] }, { content: 'x', name: 'write_file', arguments: {} },
    { calls: [null] }, { calls: [{ name: 'unknown', arguments: '{}' }] },
    { calls: [{ name: 'write_file', arguments: 'bad JSON' }] }])
    assert.throws(() => decode(JSON.stringify(value), request));
  assert.throws(() => decode(JSON.stringify({ content: null, calls: [call] }), prepare({ ...body, tool_choice: 'none' }, models)), /none/);
});

test('external execution failures are preserved as tool observations for the agent', () => {
  const history = [...body.messages, { role: 'assistant', content: null, tool_calls: [{ id: 'call_failed', type: 'function', function: { name: 'write_file', arguments: '{"path":"x"}' } }] },
    { role: 'tool', tool_call_id: 'call_failed', content: 'Permission denied: cannot write x' }];
  const request = prepare({ ...body, messages: history }, models);
  assert.deepEqual(JSON.parse(request.text).at(-1), history.at(-1));
});

test('model generation outlives control-request deadlines and stops when WorkBuddy disconnects', async () => {
  const events = [];
  let hang = false, markStarted, markDeleted;
  const fake = http.createServer(async (req, res) => {
    for await (const chunk of req) {}
    events.push(`${req.method} ${req.url}`);
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/permission') return res.end('[]');
    if (req.url === '/session') return res.end('{"id":"long"}');
    if (req.url.endsWith('/message')) {
      markStarted?.();
      if (hang) return;
      await new Promise(resolve => setTimeout(resolve, 160));
      return res.end('{"info":{"structured":{"content":"OK","calls":[]}},"parts":[]}');
    }
    res.end('true');
    if (req.method === 'DELETE') markDeleted?.();
  });
  const backend = new Backend(await listen(fake), 'test', 50);
  const server = createServer({ key: 'test', backend, getModels: () => models, status: () => ({}) });
  const base = await listen(server);
  try {
    assert.equal((await backend.complete(prepare({ model: models[0].id, messages: body.messages }, models))).choices[0].message.content, 'OK');
    hang = true; events.length = 0;
    const started = new Promise(resolve => { markStarted = resolve; });
    const deleted = new Promise(resolve => { markDeleted = resolve; });
    const controller = new AbortController();
    const response = await fetch(base + '/v1/chat/completions', { method: 'POST', signal: controller.signal,
      headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, stream: true }) });
    await started;
    controller.abort();
    await response.body.cancel().catch(() => {});
    await Promise.race([deleted, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Cancellation did not stop OpenCode')), 1500); timer.unref(); })]);
    assert.ok(events.includes('POST /session/long/abort'));
    assert.ok(events.includes('DELETE /session/long'));
  } finally { server.closeAllConnections(); server.close(); fake.closeAllConnections(); fake.close(); }
});


test('missing Write arguments reach WorkBuddy and its validation error returns to the model', () => {
  const writeBody = { ...body, tools: [{ type: 'function', function: { name: 'Write', parameters: {
    type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string' } }, required: ['file_path', 'content'],
  } } }] };
  for (const args of [{ content: 'hello' }, {}]) {
    const assistant = decode(JSON.stringify({ content: '', calls: [{ name: 'Write', arguments: args }] }), prepare(writeBody, models));
    assert.deepEqual(JSON.parse(assistant.tool_calls[0].function.arguments), args);
    const error = { role: 'tool', tool_call_id: assistant.tool_calls[0].id, content: 'Write error: Invalid parameters provided. Reason: file_path is required' };
    const next = prepare({ ...writeBody, messages: [...body.messages, assistant, error] }, models);
    assert.deepEqual(JSON.parse(next.text).slice(-2), [{ ...assistant, content: '' }, error]);
    const corrected = decode(JSON.stringify({ content: '', calls: [{ name: 'Write', arguments: { file_path: 'out.txt', content: 'hello' } }] }), next);
    assert.equal(JSON.parse(corrected.tool_calls[0].function.arguments).file_path, 'out.txt');
  }
});

test('a request result records observations without judging the model', async () => {
  const { withRequestMeta } = await import('../src/model-status.js');
  const result = withRequestMeta({ model: 'x', ok: true, category: 'available' }, { tools: 3, calls: 0, nativeAttempts: 1, steps: 4 });
  assert.equal(result.calls, 0);
  assert.equal(result.nativeAttempts, 1);
  assert.equal(result.steps, 4);
  assert.equal('noAction' in result, false, 'Capability labels come from detection, not from one work item');
});

test('request meta reaches the recorder with blocked native attempts', async () => {
  const recorded = [];
  const server = createServer({ key: 'test', getModels: () => models,
    backend: { complete: async (request, signal, meta) => {
      meta.calls = 0; meta.nativeAttempts = 1; meta.steps = 3;
      meta.permissions = [{ id: 'per_1', type: 'external_directory', title: 'read', callID: 'call_native' }];
      return completion(request.model.id, { role: 'assistant', content: 'no action' });
    } },
    onResult: async (...args) => { recorded.push(args); }, status: () => ({}) });
  const base = await listen(server);
  try {
    const response = await fetch(base + '/v1/chat/completions', { method: 'POST',
      headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, 200);
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0][1], true);
    const meta = recorded[0][8];
    assert.equal(meta.tools, 1, 'The recorder learns how many external tools were offered');
    assert.deepEqual({ calls: meta.calls, nativeAttempts: meta.nativeAttempts, steps: meta.steps }, { calls: 0, nativeAttempts: 1, steps: 3 });
    assert.equal(meta.permissions[0].type, 'external_directory');
  } finally { server.closeAllConnections(); server.close(); }
});

test('a cancelled client request is never recorded as a completed success', async () => {
  const recorded = [];
  const server = createServer({ key: 'test', getModels: () => models,
    backend: { complete: async request => {
      await new Promise(resolve => setTimeout(resolve, 150));
      return completion(request.model.id, { role: 'assistant', content: 'late' });
    } },
    onResult: async (...args) => { recorded.push(args); }, status: () => ({}) });
  const base = await listen(server);
  const controller = new AbortController();
  try {
    const pending = fetch(base + '/v1/chat/completions', { method: 'POST', signal: controller.signal,
      headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null);
    await new Promise(resolve => setTimeout(resolve, 60));
    controller.abort();
    await pending;
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.deepEqual(recorded, [], 'A cancelled request must not be recorded as a success');
  } finally { server.closeAllConnections(); server.close(); }
});

test('captured approval payloads keep their shape without unbounded file content', async () => {
  const { shrinkPermission } = await import('../src/backend.js');
  const shrunk = shrinkPermission({ id: 'per_1', permission: 'external_directory', patterns: ['/tmp/*'],
    metadata: { filepath: '/tmp/a.md', content: 'x'.repeat(5000) } }, 20);
  assert.equal(shrunk.permission, 'external_directory');
  assert.deepEqual(shrunk.patterns, ['/tmp/*']);
  assert.equal(shrunk.metadata.filepath, '/tmp/a.md');
  assert.equal(shrunk.metadata.content, `${'x'.repeat(20)}…[5000 chars]`);
});

test('an in-flight request reports upstream retries from the event stream', async () => {
  const progress = [];
  let streamed;
  const fake = http.createServer(async (req, res) => {
    if (req.url === '/event') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      streamed = res;
      return;
    }
    let text = ''; for await (const chunk of req) text += chunk;
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/session') return res.end('{"id":"ses_events"}');
    if (req.url === '/permission') return res.end('[]');
    if (req.url.endsWith('/message')) {
      await new Promise(resolve => setTimeout(resolve, 400));
      return res.end('{"info":{"structured":{"content":"OK","calls":[]}},"parts":[]}');
    }
    res.end('true');
  });
  const backend = new Backend(await listen(fake), 'test');
  const event = payload => `data: ${JSON.stringify({ directory: '/tmp', payload })}\n\n`;
  try {
    const meta = { activity: record => progress.push(record), model: models[0].id };
    const done = backend.complete(prepare(body, models), undefined, meta);
    for (let i = 0; i < 40 && !streamed; i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(streamed, 'The bridge subscribes to the event stream while a request runs');
    streamed.write(event({ type: 'session.status', properties: { sessionID: 'ses_events', status: { type: 'retry', attempt: 2, message: 'socket closed', next: 1000 } } }));
    streamed.write(event({ type: 'message.part.updated', properties: { part: { sessionID: 'ses_events', type: 'reasoning', text: 'thinking' } } }));
    streamed.write(event({ type: 'session.status', properties: { sessionID: 'ses_other', status: { type: 'retry', attempt: 9 } } }));
    await done;
    const retry = progress.find(p => p.status === 'retry');
    assert.equal(retry.attempt, 2, 'The upstream retry attempt is reported');
    assert.equal(retry.model, models[0].id);
    assert.equal(retry.message, 'socket closed');
    assert.ok(progress.some(p => p.status === 'reasoning' && p.content), 'Real OpenCode part events carry sessionID inside part');
    assert.ok(progress.some(p => p.type === 'request.done'), 'Completion is reported so the entry is removed');
    assert.ok(!progress.some(p => p.sessionID === 'ses_other'), 'Other sessions are ignored');
  } finally { backend.stopEvents(); fake.closeAllConnections(); fake.close(); }
});

test('detection requires an action, not just a valid envelope', async () => {
  const { probeBody, judgeProbe, probeFailure } = await import('../src/probe.js');
  const { modelResult } = await import('../src/model-status.js');
  const token = 'probe-token-1';

  const body = probeBody(models[0], token);
  assert.equal(body.tool_choice, undefined, 'Detection must not force a tool call');
  assert.ok(body.tools.length >= 5, 'Detection exercises the multi-tool schema path');
  assert.deepEqual(body.tools.find(t => t.function.name === 'Read').function.parameters.required, ['file_path']);
  assert.ok(body.messages[0].content.includes(token));

  const textOnly = completion(models[0].id, { role: 'assistant', content: '我无法访问文件。' });
  assert.throws(() => judgeProbe(textOnly, token), e => e.code === 'no_action');

  const acted = completion(models[0].id, { role: 'assistant', content: null,
    tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'Read', arguments: JSON.stringify({ file_path: `/external/probe-${token}.txt` }) } }] });
  assert.equal(judgeProbe(acted, token).function.name, 'Read');

  const unrelated = completion(models[0].id, { role: 'assistant', content: null,
    tool_calls: [{ id: 'call_2', type: 'function', function: { name: 'Bash', arguments: '{"command":"ls"}' } }] });
  assert.throws(() => judgeProbe(unrelated, token), e => e.code === 'probe_mismatch' && /Bash/.test(e.message));

  const timedOut = probeFailure(new Error('The operation was aborted'), true);
  assert.equal(timedOut.name, 'TimeoutError', 'A real deadline must not look like an opaque abort');
  assert.equal(timedOut.code, 'timeout');
  assert.equal(probeFailure(new Error('boom'), false).message, 'boom');

  assert.equal(modelResult(false, '模型只返回了文本，没有产生任何动作', 502, 'no_action').category, 'error', 'A text-only probe reply becomes chat-only, not its own category');
  assert.equal(modelResult(false, 'Model probe timed out', 504, 'timeout').category, 'timeout');
});

test('every detection category has a label the panel can show', async () => {
  const fs = await import('node:fs/promises');
  const { modelResult } = await import('../src/model-status.js');
  const renderer = await fs.readFile(new URL('../desktop/renderer.js', import.meta.url), 'utf8');
  const expected = { timeout: '检测超时', quota: '额度不足', rate_limit: '请求受限', access: '访问受限' };

  assert.equal(modelResult(false, '模型只返回了文本，没有产生任何动作', 502, 'no_action').category, 'error', 'A text-only probe reply becomes chat-only, not its own category');
  assert.equal(modelResult(false, 'Model probe timed out', 504, 'timeout').category, 'timeout');
  assert.equal(modelResult(false, 'insufficient_quota', 429).category, 'quota');
  assert.equal(modelResult(false, 'Too many requests', 429).category, 'rate_limit');
  assert.equal(modelResult(false, 'Free tier only within OpenCode', 403).category, 'access');
  assert.equal(modelResult(true).category, 'available');

  for (const [category, label] of Object.entries(expected))
    assert.match(renderer, new RegExp(`${category}: '${label}'`), `The panel must label ${category} as ${label}`);
  assert.match(renderer, /toolcall === false \? '可用 · 仅对话'/, 'The panel must show the chat-only state');
});

test('only format incompatibility degrades a model to chat-only', async () => {
  const { formatUnsupported } = await import('../src/probe.js');
  assert.equal(formatUnsupported({ code: 'invalid_model_output' }), true);
  assert.equal(formatUnsupported({ code: 'invalid_tool_call' }), true);
  assert.equal(formatUnsupported({ message: 'only `"auto"` is supported for `tool_choice`' }), true);
  assert.equal(formatUnsupported({ code: 'probe_mismatch', message: '模型返回的动作与探测请求不符（收到 Bash）' }), false,
    'A wrong action is not a format problem either');
  assert.equal(formatUnsupported({ code: 'native_tool_activity', message: 'OpenCode repeatedly attempted native actions; execution was not approved' }), false,
    'Refusing to act is not a format problem: such a model must not be published as chat-only');
  assert.equal(formatUnsupported({ code: 'timeout', message: 'Model probe timed out' }), false);
  assert.equal(formatUnsupported({ code: 'no_action', message: '模型只返回了文本，没有产生任何动作' }), false);
});

test('a blocked native bash action maps to the external Bash tool', async () => {
  const { buildHandoff } = await import('../src/handoff.js');
  const tools = [{ type: 'function', function: { name: 'Bash', parameters: { type: 'object',
    properties: { command: { type: 'string' }, description: { type: 'string' } }, required: ['command'] } } }];
  const handoff = buildHandoff({ native: 'bash', input: { command: 'ls /Users/Zhuanz/WorkBuddy/', description: 'list' }, tools });
  assert.deepEqual(handoff, { name: 'Bash', arguments: { command: 'ls /Users/Zhuanz/WorkBuddy/', description: 'list' } });
  assert.equal(buildHandoff({ native: 'bash', input: { description: 'no command' }, tools }), null, 'required arguments must be satisfiable');
});

test('a blocked native read maps to Read with the external field name', async () => {
  const { buildHandoff } = await import('../src/handoff.js');
  const tools = [{ type: 'function', function: { name: 'Read', parameters: { type: 'object',
    properties: { file_path: { type: 'string' } }, required: ['file_path'] } } }];
  assert.deepEqual(buildHandoff({ native: 'read', input: { filePath: '/tmp/a.md' }, tools }),
    { name: 'Read', arguments: { file_path: '/tmp/a.md' } });
  assert.deepEqual(buildHandoff({ native: 'write', input: { filePath: '/tmp/a.md', content: 'x' }, tools }), null,
    'no Write tool was supplied, so nothing may be invented');
});

test('an action without an external equivalent is reported by name, not silently dropped', async () => {
  const { buildHandoff, rejectFeedback } = await import('../src/handoff.js');
  const tools = [{ type: 'function', function: { name: 'Read', parameters: { type: 'object',
    properties: { file_path: { type: 'string' } }, required: ['file_path'] } } }];
  assert.equal(buildHandoff({ native: 'glob', input: { pattern: '**/*.md' }, tools }), null);
  const feedback = rejectFeedback('glob', 'its arguments cannot be mapped onto an external tool schema supplied in this request');
  assert.match(feedback, /"glob"/);
  assert.match(feedback, /cannot be mapped/);
  assert.match(feedback, /calls array/);
});

test('a handed-over native action becomes the answer without a second model turn', async () => {
  const events = []; let waiting = false; let polls = 0;
  const bashTool = { type: 'function', function: { name: 'Bash', description: 'Run a shell command',
    parameters: { type: 'object', properties: { command: { type: 'string' }, description: { type: 'string' } }, required: ['command'] } } };
  const fake = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    events.push(`${req.method} ${req.url}`);
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/session') return res.end('{"id":"ses_handoff"}');
    if (req.url === '/permission' && ++polls === 1) return req.socket.destroy();
    if (req.url === '/permission') return res.end(JSON.stringify(waiting ? [{ id: 'per_bash', sessionID: 'ses_handoff',
      permission: 'external_directory', metadata: { command: 'ls /tmp' }, tool: { callID: 'native_bash' } }] : []));
    if (req.url === '/session/ses_handoff/message' && req.method === 'GET') return res.end(JSON.stringify([{ parts: [
      { type: 'tool', callID: 'native_bash', tool: 'bash', state: { status: 'running', input: { command: 'ls /tmp', description: 'list the directory' } } }] }]));
    if (req.url === '/session/ses_handoff/message') { waiting = true; return; }
    res.end('true');
  });
  const backend = new Backend(await listen(fake), 'test');
  // The event stream reports the blocked call; the approval only carries its call ID.
  backend.toolParts.set('native_bash', { tool: 'bash', input: { command: 'ls /tmp', description: 'list the directory' } });
  try {
    const result = await backend.complete(prepare({ model: models[0].id, messages: body.messages, tools: [bashTool] }, models));
    const call = result.choices[0].message.tool_calls[0];
    assert.equal(call.function.name, 'Bash');
    assert.ok(polls >= 2, 'Permission polling recovers before handing off the blocked tool');
    assert.deepEqual(JSON.parse(call.function.arguments), { command: 'ls /tmp', description: 'list the directory' });
    assert.ok(events.includes('POST /session/ses_handoff/abort'), 'The generation is stopped once the action is handed over');
  } finally { backend.stopEvents(); fake.closeAllConnections(); fake.close(); }
});

test('an unmappable native action is refused by name and the request still completes', async () => {
  const events = []; const replies = []; let phase = 'idle'; let held;
  const readTool = { type: 'function', function: { name: 'Read', description: 'Read a file',
    parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } } };
  const fake = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    events.push(`${req.method} ${req.url}`);
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/session') return res.end('{"id":"ses_unmapped"}');
    if (req.url === '/permission') return res.end(JSON.stringify(phase === 'asking' ? [{ id: 'per_glob', sessionID: 'ses_unmapped',
      permission: 'external_directory', metadata: {}, tool: { callID: 'native_glob' } }] : []));
    if (req.url === '/session/ses_unmapped/message' && req.method === 'GET') return res.end(JSON.stringify([{ parts: [
      { type: 'tool', callID: 'native_glob', tool: 'glob', state: { status: 'running', input: { pattern: '**/*.md' } } }] }]));
    if (req.url.endsWith('/reply')) {
      replies.push(JSON.parse(raw));
      phase = 'replied';
      if (held) { const response = held; held = null; response.end('{"info":{"structured":{"content":"OK","calls":[]}},"parts":[]}'); }
      return res.end('true');
    }
    if (req.url === '/session/ses_unmapped/message') {
      if (phase === 'replied') return res.end('{"info":{"structured":{"content":"OK","calls":[]}},"parts":[]}');
      phase = 'asking'; held = res; return;
    }
    res.end('true');
  });
  const backend = new Backend(await listen(fake), 'test');
  backend.toolParts.set('native_glob', { tool: 'glob', input: { pattern: '**/*.md' } });
  try {
    const result = await backend.complete(prepare({ model: models[0].id, messages: body.messages, tools: [readTool] }, models));
    assert.equal(result.choices[0].message.content, 'OK', 'A refused native call must not abort the whole request');
    assert.equal(replies.length, 1);
    assert.equal(replies[0].reply, 'reject');
    assert.match(replies[0].message, /"glob"/, 'The feedback names the tool that could not be mapped');
    assert.ok(!events.includes('POST /session/ses_unmapped/abort'));
  } finally { backend.stopEvents(); fake.closeAllConnections(); fake.close(); }
});

test('a pending call takes its arguments from the approval metadata', async () => {
  const { handoffInput, buildHandoff } = await import('../src/handoff.js');
  const tools = [{ type: 'function', function: { name: 'Read', parameters: { type: 'object',
    properties: { file_path: { type: 'string' } }, required: ['file_path'] } } }];
  // A pending tool part reports no input; the path is only in the approval metadata.
  const input = handoffInput({ tool: 'read', input: {} }, { metadata: { filepath: '/tmp/a.md', parentDir: '/tmp' } });
  assert.deepEqual(input, { filePath: '/tmp/a.md' });
  assert.deepEqual(buildHandoff({ native: 'read', input, tools }), { name: 'Read', arguments: { file_path: '/tmp/a.md' } });
  // Real arguments win over the metadata fallback.
  assert.deepEqual(handoffInput({ input: { filePath: '/real.md' } }, { metadata: { filepath: '/other.md' } }), { filePath: '/real.md' });
  assert.deepEqual(handoffInput(null, { metadata: { command: 'ls /tmp' } }), { command: 'ls /tmp' });
});

test('a bash approval without a readable tool part is still handed over', async () => {
  const events = []; let phase = 'idle';
  const bashTool = { type: 'function', function: { name: 'Bash', description: 'Run a shell command',
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } };
  const fake = http.createServer(async (req, res) => {
    events.push(`${req.method} ${req.url}`);
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/session') return res.end('{"id":"ses_meta"}');
    if (req.url === '/permission') return res.end(JSON.stringify(phase === 'asking'
      ? [{ id: 'per_meta', sessionID: 'ses_meta', permission: 'external_directory', metadata: { command: 'ls /tmp' }, tool: { callID: 'native_meta' } }] : []));
    if (req.url === '/session/ses_meta/message' && req.method === 'GET') return res.end('[]');
    if (req.url.endsWith('/reply')) { phase = 'replied'; return res.end('true'); }
    if (req.url === '/session/ses_meta/message') { phase = 'asking'; return; }
    res.end('true');
  });
  const backend = new Backend(await listen(fake), 'test');
  try {
    const result = await backend.complete(prepare({ model: models[0].id, messages: body.messages, tools: [bashTool] }, models));
    const call = result.choices[0].message.tool_calls[0];
    assert.equal(call.function.name, 'Bash');
    assert.deepEqual(JSON.parse(call.function.arguments), { command: 'ls /tmp' });
    assert.ok(events.includes('POST /session/ses_meta/abort'));
  } finally { backend.stopEvents(); fake.closeAllConnections(); fake.close(); }
});

test('a failed handoff reports why instead of swallowing the reason', async () => {
  const events = []; let phase = 'idle'; let held;
  const readTool = { type: 'function', function: { name: 'Read', description: 'Read a file',
    parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } } };
  const fake = http.createServer(async (req, res) => {
    events.push(`${req.method} ${req.url}`);
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/session') return res.end('{"id":"ses_why"}');
    if (req.url === '/permission') return res.end(JSON.stringify(phase === 'asking'
      ? [{ id: 'per_why', sessionID: 'ses_why', permission: 'external_directory', metadata: {}, tool: { callID: 'native_why' } }] : []));
    if (req.url === '/session/ses_why/message' && req.method === 'GET') { res.statusCode = 500; return res.end('{"error":"boom"}'); }
    if (req.url.endsWith('/reply')) { phase = 'replied'; if (held) { const r = held; held = null; r.end('{"info":{"structured":{"content":"OK","calls":[]}},"parts":[]}'); } return res.end('true'); }
    if (req.url === '/session/ses_why/message') { phase = 'asking'; held = res; return; }
    res.end('true');
  });
  const backend = new Backend(await listen(fake), 'test');
  const meta = {};
  try {
    await backend.complete(prepare({ model: models[0].id, messages: body.messages, tools: [readTool] }, models), undefined, meta);
    assert.ok(meta.handoffCheck, 'The refusal records why it happened');
    assert.match(meta.handoffCheck.detail, /no event carried this call ID/, 'The failure to identify the call is reported, not swallowed');
  } finally { backend.stopEvents(); fake.closeAllConnections(); fake.close(); }
});

test('a semantic probe miss is retried once, a format failure is not', async () => {
  const { probeModel, RETRYABLE_PROBE } = await import('../src/probe.js');
  assert.equal(RETRYABLE_PROBE.has('probe_mismatch'), true);
  assert.equal(RETRYABLE_PROBE.has('no_action'), true);
  assert.equal(RETRYABLE_PROBE.has('invalid_model_output'), false, 'Format failures keep the chat-only path');
  assert.equal(RETRYABLE_PROBE.has('timeout'), false, 'A timeout is load, not a fluke');
  assert.equal(RETRYABLE_PROBE.has('native_tool_activity'), false);

  const textOnly = () => completion(models[0].id, { role: 'assistant', content: 'no action' });
  const acted = token => completion(models[0].id, { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function',
    function: { name: 'Read', arguments: JSON.stringify({ file_path: `/external/probe-${token}.txt` }) } }] });

  let calls = 0;
  const response = await probeModel({ complete: async token => { calls++; return calls === 1 ? textOnly() : acted(token); } });
  assert.equal(calls, 2, 'A single miss is retried');
  assert.equal(response.choices[0].message.tool_calls[0].function.name, 'Read');

  let attempts = 0;
  await assert.rejects(probeModel({ complete: async () => { attempts++; return textOnly(); } }), e => e.code === 'no_action');
  assert.equal(attempts, 2, 'Two misses in a row still fail');

  let formatAttempts = 0;
  await assert.rejects(probeModel({ complete: async () => { formatAttempts++; throw Object.assign(new Error('Invalid model response envelope'), { code: 'invalid_model_output' }); } }), /envelope/);
  assert.equal(formatAttempts, 1, 'A format failure is not retried here');
});

test('glob, grep and skill map onto their external equivalents', async () => {
  const { buildHandoff, handoffInput } = await import('../src/handoff.js');
  const spec = (name, properties, required) => ({ type: 'function', function: { name, parameters: { type: 'object', properties, required } } });

  const glob = spec('Glob', { pattern: { type: 'string' }, path: { type: 'string' } }, ['pattern']);
  assert.deepEqual(buildHandoff({ native: 'glob', input: { pattern: '**/*.html', path: '/tmp' }, tools: [glob] }),
    { name: 'Glob', arguments: { pattern: '**/*.html', path: '/tmp' } });

  // A directory listing tool has no pattern field: only the keys it declares are filled.
  const ls = spec('LS', { path: { type: 'string' } }, ['path']);
  assert.deepEqual(buildHandoff({ native: 'glob', input: { pattern: '**/*.html', path: '/tmp' }, tools: [ls] }),
    { name: 'LS', arguments: { path: '/tmp' } });

  const grep = spec('Grep', { pattern: { type: 'string' }, include: { type: 'string' } }, ['pattern']);
  assert.deepEqual(buildHandoff({ native: 'grep', input: { pattern: 'popmart', include: '*.md' }, tools: [grep] }),
    { name: 'Grep', arguments: { pattern: 'popmart', include: '*.md' } });

  // External skill tools disagree on the argument name; the declared one wins.
  const skill = spec('Skill', { skill: { type: 'string' }, args: { type: 'string' } }, ['skill']);
  assert.deepEqual(buildHandoff({ native: 'skill', input: { name: 'deep-research' }, tools: [skill] }),
    { name: 'Skill', arguments: { skill: 'deep-research' } });

  // The approval metadata carries the pattern when the tool part is still pending.
  assert.deepEqual(handoffInput({ input: {} }, { metadata: { patterns: ['**/*.html'] } }), { pattern: '**/*.html' });
  assert.deepEqual(handoffInput({ input: {} }, { metadata: { pattern: '**/*.md' } }), { pattern: '**/*.md' });

  // Nothing is invented when the target cannot carry the call.
  assert.equal(buildHandoff({ native: 'glob', input: { pattern: '**/*' }, tools: [grep] }), null);
});

test('the envelope is read from a completed StructuredOutput call', async () => {
  const fake = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/session') return res.end('{"id":"ses_structured"}');
    if (req.url === '/permission') return res.end('[]');
    if (req.url.endsWith('/message')) return res.end(JSON.stringify({
      info: { tokens: { input: 3, output: 2 } },
      parts: [{ type: 'tool', tool: 'StructuredOutput', callID: 'call_structured', state: { status: 'completed',
        input: { content: 'OK', calls: [{ name: 'write_file', arguments: { path: 'a' } }] } } }],
    }));
    res.end('true');
  });
  const backend = new Backend(await listen(fake), 'test');
  try {
    const result = await backend.complete(prepare(body, models));
    assert.equal(result.choices[0].message.content, 'OK');
    assert.equal(result.choices[0].message.tool_calls[0].function.name, 'write_file',
      'A completed StructuredOutput call carries the envelope even without info.structured');
  } finally { backend.stopEvents(); fake.closeAllConnections(); fake.close(); }
});

test('an empty response says what was missing instead of blaming the envelope format', async () => {
  const fake = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/session') return res.end('{"id":"ses_empty"}');
    if (req.url === '/permission') return res.end('[]');
    if (req.url.endsWith('/message')) return res.end('{"info":{},"parts":[]}');
    res.end('true');
  });
  const backend = new Backend(await listen(fake), 'test');
  try {
    await assert.rejects(backend.complete(prepare(body, models)), e => e.code === 'invalid_model_output' && /三者都为空/.test(e.message));
  } finally { backend.stopEvents(); fake.closeAllConnections(); fake.close(); }
});

test('a null envelope field defaults from the other instead of failing the format', () => {
  const request = prepare(body, models);
  const call = { name: 'write_file', arguments: { path: 'x' } };
  assert.deepEqual(decode('{"content":null,"calls":[]}', request), { role: 'assistant', content: '' },
    'null content with no calls means an empty answer, not a format error');
  assert.deepEqual(decode(JSON.stringify({ content: 'hi', calls: null, reasoning: 'because' }), request),
    { role: 'assistant', content: 'hi' },
    'extra fields must not stop calls from defaulting to an empty list');
  assert.equal(decode(JSON.stringify({ content: null, calls: [call] }), request).content, null,
    'a tool-only reply still reports null content');
  assert.throws(() => decode('{}', request), /Invalid model response envelope \(content=undefined, calls=undefined\)/,
    'an envelope with neither field is still nothing at all');
  assert.throws(() => decode('{"content":5,"calls":[]}', request), /content=number/,
    'the rejection must name the field that was wrong');
  assert.throws(() => decode('{"content":"x","name":"write_file","arguments":{}}', request),
    /Invalid model response envelope/,
    'a tool call flattened into the envelope must never pass as a plain text answer');
});

test('an unreadable envelope is translated once and used when the receiver accepts it', async () => {
  const request = prepare(body, models);
  const backend = new Backend('http://unused', 'test');
  backend.translator = () => 'opencode/big-pickle';
  const messages = new Map();
  let sessions = 0;
  backend.request = async (route, method, payload) => {
    if (route === '/session') { sessions += 1; return { id: `ses_${sessions - 1}` }; }
    if (route.endsWith('/message')) {
      const id = route.split('/')[2];
      messages.set(id, payload);
      if (id === 'ses_0') return { info: { structured: { content: 5, calls: [] } }, parts: [] };
      return { parts: [{ type: 'text', text: 'Here you go:\n```json\n{"content":"ok","calls":[{"name":"write_file","arguments":{"path":"x"}}]}\n```' }] };
    }
    return [];
  };
  const meta = {};
  const result = await backend.complete(request, undefined, meta);
  assert.equal(sessions, 2, 'The translator runs in its own session');
  assert.equal(messages.get('ses_1').model.modelID, 'big-pickle');
  assert.equal(messages.get('ses_1').agent, 'buddy-chat', 'Translation is a text job, never a tool job');
  assert.equal(result.choices[0].message.tool_calls[0].function.name, 'write_file');
  assert.equal(meta.repaired.envelope.ok, true);
  assert.equal(meta.repaired.envelope.model, 'opencode/big-pickle');
});

test('a translation the receiver rejects leaves the original error untouched', async () => {
  const request = prepare(body, models);
  const backend = new Backend('http://unused', 'test');
  backend.translator = () => 'opencode/big-pickle';
  const sessions = [];
  backend.request = async (route, method, payload) => {
    if (route === '/session') { const id = `ses_${sessions.length}`; sessions.push({ id, payload }); return { id }; }
    if (route.endsWith('/message')) {
      if (route.startsWith('/session/ses_0/')) return { info: { structured: { content: 5, calls: [] } }, parts: [] };
      return { parts: [{ type: 'text', text: '{"content":"ok","calls":[{"name":"rm_rf","arguments":{}}]}' }] };
    }
    return [];
  };
  const meta = {};
  await assert.rejects(backend.complete(request, undefined, meta), error => error.code === 'invalid_model_output');
  assert.equal(meta.repaired.envelope.ok, false, 'An out-of-list translation must never be used');
  assert.equal(meta.repaired.envelope.reason, 'invalid_tool_call');
});

test('a blocked native action that no table can express is translated into an external call', async () => {
  const request = prepare(body, models);
  const backend = new Backend('http://unused', 'test');
  backend.translator = () => 'opencode/big-pickle';
  const sessions = [];
  let answered = false;
  backend.request = async (route, method, payload) => {
    if (route === '/session') { const id = `ses_${sessions.length}`; sessions.push({ id, payload }); return { id }; }
    if (route.endsWith('/permission')) {
      if (answered) return [];
      answered = true;
      return [{ id: 'per_1', sessionID: 'ses_0', permission: 'bash', patterns: ['*'], metadata: { command: 'ls -la' } }];
    }
    if (route.endsWith('/message')) {
      if (route.startsWith('/session/ses_0/')) return { info: { structured: { content: '我先看看', calls: [] } }, parts: [] };
      return { parts: [{ type: 'text', text: '{"name":"write_file","arguments":{"path":"notes.txt"}}' }] };
    }
    return [];
  };
  const meta = {};
  const result = await backend.complete(request, undefined, meta);
  assert.equal(meta.handoffCheck.native, 'bash', 'The table could not express a shell command for this receiver');
  assert.equal(meta.repaired.action.ok, true);
  assert.equal(meta.handoff, 'write_file');
  assert.equal(result.choices[0].message.tool_calls[0].function.name, 'write_file');
  assert.deepEqual(JSON.parse(result.choices[0].message.tool_calls[0].function.arguments), { path: 'notes.txt' });
});

test('a call whose arguments failed to parse is a format problem, not native activity', async () => {
  const request = prepare(body, models);
  const backend = new Backend('http://unused', 'test');
  backend.translator = () => 'opencode/big-pickle';
  const messages = new Map();
  let sessions = 0;
  const unparsed = { type: 'tool', tool: 'invalid', callID: 'call_bad', state: { status: 'completed',
    input: { tool: 'StructuredOutput', error: 'Invalid input for tool StructuredOutput: JSON parsing failed: Text: {"content": "数据核对完毕", "invoke name=\\"calls": .' } } };
  backend.request = async (route, method, payload) => {
    if (route === '/session') { sessions += 1; return { id: `ses_${sessions - 1}` }; }
    if (route.endsWith('/message')) {
      const id = route.split('/')[2];
      messages.set(id, payload);
      if (id === 'ses_0') return { info: {}, parts: [unparsed] };
      return { parts: [{ type: 'text', text: '{"content":"ok","calls":[{"name":"write_file","arguments":{"path":"x"}}]}' }] };
    }
    return [];
  };
  const meta = {};
  const result = await backend.complete(request, undefined, meta);
  assert.equal(sessions, 2, 'The turn continues through the format path instead of being discarded');
  assert.match(messages.get('ses_1').parts[0].text, /JSON parsing failed/, 'The translator receives the parse error as material');
  assert.equal(result.choices[0].message.tool_calls[0].function.name, 'write_file');
  assert.equal(meta.repaired.envelope.ok, true);
});

test('an unparsable call is never reported as unexpected native activity', async () => {
  const request = prepare(body, models);
  const backend = new Backend('http://unused', 'test');
  let sessions = 0;
  backend.request = async route => {
    if (route === '/session') { sessions += 1; return { id: `ses_${sessions - 1}` }; }
    if (route.endsWith('/message')) return { info: {}, parts: [{ type: 'tool', tool: 'invalid', callID: 'call_bad', state: { status: 'completed', input: { error: 'JSON parsing failed' } } }] };
    return [];
  };
  await assert.rejects(backend.complete(request, undefined, {}),
    error => error.code === 'invalid_model_output' && /不是合法 JSON/.test(error.message));
});

test('the material carries the external conversation the translation must be grounded in', async () => {
  const request = prepare(body, models);
  const backend = new Backend('http://unused', 'test');
  backend.translator = () => 'opencode/big-pickle';
  const messages = new Map();
  let sessions = 0;
  backend.request = async (route, method, payload) => {
    if (route === '/session') { sessions += 1; return { id: `ses_${sessions - 1}` }; }
    if (route.endsWith('/message')) {
      const id = route.split('/')[2];
      messages.set(id, payload);
      if (id === 'ses_0') return { info: { structured: { content: 5, calls: [] } }, parts: [] };
      return { parts: [{ type: 'text', text: '{"content":"ok","calls":[]}' }] };
    }
    return [];
  };
  await backend.complete(request, undefined, {});
  const body_ = JSON.parse(messages.get('ses_1').parts[0].text);
  assert.deepEqual(body_.material.conversation.at(-1), { role: 'user', content: 'Write a file' });
  assert.equal(body_.tools[0].description, tools[0].function.description);
  assert.match(body_.conventions, /complete supplied file content/);
});

test('with nothing to infer from, the model is told what failed and asked once more', async () => {
  const request = prepare(body, models);
  const backend = new Backend('http://unused', 'test');
  const sent = [];
  backend.request = async (route, method, payload) => {
    if (route === '/session') return { id: 'ses_retry' };
    if (route.endsWith('/message')) {
      // The bridge rewrites payload.parts in place, so keep the text as it was sent.
      sent.push(payload.parts[0].text);
      if (sent.length < 3) return { info: { structured: { content: 5, calls: [] } }, parts: [] };
      return { info: { structured: { content: '', calls: [{ name: 'write_file', arguments: { path: 'x' } }] } }, parts: [] };
    }
    return [];
  };
  const meta = {};
  const result = await backend.complete(request, undefined, meta);
  assert.equal(sent.length, 3, 'The format correction, then one explicit retry');
  assert.match(sent[1], /adapter JSON format check/);
  assert.match(sent[2], /补齐诊断指出的缺失项后重发/);
  assert.match(sent[2], /Invalid model response envelope/, 'The model is told what actually failed');
  assert.equal(meta.repaired.envelope.reason, 'no translator available');
  assert.equal(result.choices[0].message.tool_calls[0].function.name, 'write_file');
});

test('detection never spends the extra round', async () => {
  const request = prepare(body, models);
  const backend = new Backend('http://unused', 'test');
  let calls = 0;
  backend.request = async route => {
    if (route === '/session') return { id: 'ses_probe' };
    if (route.endsWith('/message')) { calls += 1; return { info: { structured: { content: 5, calls: [] } }, parts: [] }; }
    return [];
  };
  await assert.rejects(backend.complete(request, undefined, { probe: true }), error => error.code === 'invalid_model_output');
  assert.equal(calls, 2, 'A probe stops after the single format correction');
});

test('a reply cut off by the output limit is asked again, compactly', async () => {
  const request = prepare(body, models);
  const backend = new Backend('http://unused', 'test');
  const sent = [];
  backend.request = async (route, method, payload) => {
    if (route === '/session') return { id: 'ses_cut' };
    if (route.endsWith('/message')) {
      sent.push(payload.parts[0].text);
      if (sent.length < 3) return { info: { finish: 'length', tokens: { output: 20000 } }, parts: [] };
      return { info: { structured: { content: '', calls: [{ name: 'write_file', arguments: { path: 'x' } }] } }, parts: [] };
    }
    return [];
  };
  const meta = {};
  const result = await backend.complete(request, undefined, meta);
  assert.equal(sent.length, 3, 'Correction, translation attempt, explicit retry');
  assert.match(sent[1], /cut off by the output limit/);
  assert.match(sent[2], /截断/);
  assert.match(sent[2], /缩短说明和推理/, 'The retry reduces explanation while preserving complete arguments');
  assert.equal(result.choices[0].message.tool_calls[0].function.name, 'write_file');
});

test('silent inference remains active past five minutes until the client cancels', async t => {
  const backend = new Backend('http://unused', 'test');
  backend.watchEvents = () => {};
  const controller = new AbortController();
  const routes = [];
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  backend.request = async route => {
    routes.push(route);
    if (route === '/session') return { id: 'ses_silent' };
    if (route.endsWith('/message')) {
      entered();
      return new Promise((resolve, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true }));
    }
    return [];
  };
  let failure, finished = false;
  const running = backend.complete(prepare(body, models), controller.signal, { activity: () => {} })
    .catch(error => { failure = error; }).finally(() => { finished = true; });
  try {
    await started;
    const later = Date.now() + 600000;
    t.mock.method(Date, 'now', () => later);
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.equal(finished, false, 'Ten minutes without content must not trigger a proxy-owned cutoff');
  } finally { controller.abort(new Error('client canceled')); await running; }
  assert.equal(failure.message, 'client canceled');
  assert.ok(routes.includes('/session/ses_silent/abort'));
  assert.ok(routes.includes('/session/ses_silent'));
});

test('native handoff and translation honor the current tool choice', async () => {
  const offered = ['Bash', 'Read'].map(name => ({ type: 'function', function: { name,
    parameters: { type: 'object', properties: name === 'Bash' ? { command: { type: 'string' } } : { file_path: { type: 'string' } },
      required: [name === 'Bash' ? 'command' : 'file_path'] } } }));
  for (const [choice, expected, handed] of [
    ['none', [], false],
    [{ type: 'function', function: { name: 'Read' } }, ['Read'], false],
    [{ type: 'function', function: { name: 'Bash' } }, ['Bash'], true],
    ['auto', ['Bash', 'Read'], true],
    ['required', ['Bash', 'Read'], true],
  ]) {
    const request = prepare({ ...body, tools: offered, tool_choice: choice }, models);
    const backend = new Backend('http://unused', 'test');
    backend.toolParts.set('blocked', { tool: 'bash', input: { command: 'pwd' } });
    const replies = [];
    backend.reject = async (p, message) => { replies.push(message); };
    const meta = { nativeAttempts: 0, permissions: [] };
    const direct = await backend.handlePermission({ id: 'p', tool: { callID: 'blocked' } }, request, undefined, new Set(), meta);
    assert.equal(Boolean(direct?.handoff), handed);
    assert.equal(replies.length, 1);
    backend.translator = () => 'opencode/translator';
    backend.complete = async inner => {
      assert.deepEqual(JSON.parse(inner.text).tools.map(t => t.name), expected);
      // Even a translator ignoring its narrowed catalog must not bypass the client's choice.
      return { choices: [{ message: { content: JSON.stringify({ name: 'Bash', arguments: { command: 'pwd' } }) } }] };
    };
    const translated = await backend.translate(request, 'action', {}, {}, {}, undefined);
    assert.equal(Boolean(translated), handed);
  }
});

test('permission monitor recovers after transient query failures without aborting inference', async () => {
  let polls = 0;
  const logs = [];
  const fake = http.createServer(async (req, res) => {
    for await (const chunk of req) {}
    if (req.url === '/session') return res.end('{"id":"ses_monitor"}');
    if (req.url === '/permission') {
      polls++;
      if (polls === 1) return req.socket.destroy();
      if (polls === 2) return res.end('{"unexpected":true}');
      return res.end('[]');
    }
    if (req.url.endsWith('/message')) {
      await new Promise(resolve => setTimeout(resolve, 650));
      return res.end('{"info":{},"parts":[{"type":"text","text":"{\\"content\\":\\"OK\\",\\"calls\\":[]}"}]}');
    }
    res.end('true');
  });
  const backend = new Backend(await listen(fake), 'test', undefined, line => logs.push(line));
  try {
    const response = await backend.complete(prepare(body, models));
    assert.equal(response.choices[0].message.content, 'OK');
    assert.ok(polls >= 3);
    assert.ok(logs.some(line => line.includes('ECONNRESET')));
    assert.ok(logs.some(line => line.includes('non-array')));
  } finally { fake.closeAllConnections(); fake.close(); }
});

test('unavailable permission polling preserves client cancellation and inference connection errors', async () => {
  for (const cancel of [true, false]) {
    const fake = http.createServer(async (req, res) => {
      for await (const chunk of req) {}
      if (req.url === '/session') return res.end('{"id":"ses_unavailable"}');
      if (req.url === '/permission') { res.statusCode = 503; return res.end('{}'); }
      if (req.url.endsWith('/message')) {
        if (!cancel) setTimeout(() => req.socket.destroy(), 60);
        return;
      }
      res.end('true');
    });
    const backend = new Backend(await listen(fake), 'test');
    const controller = new AbortController();
    const timer = cancel ? setTimeout(() => controller.abort(), 100) : null;
    try {
      await assert.rejects(backend.complete(prepare(body, models), controller.signal),
        error => error.code === (cancel ? 'ABORT_ERR' : 'ECONNRESET'));
    } finally { clearTimeout(timer); fake.closeAllConnections(); fake.close(); }
  }
});

test('permission events preserve handoff when the permission listing cannot serialize metadata', async () => {
  const events = []; let waiting = false; let polls = 0;
  const bashTool = { type: 'function', function: { name: 'Bash', description: 'Run a shell command',
    parameters: { type: 'object', properties: { command: { type: 'string' }, description: { type: 'string' } }, required: ['command'] } } };
  const fake = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    events.push(`${req.method} ${req.url}`);
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/session') return res.end('{"id":"ses_handoff"}');
    if (req.url === '/permission') { polls++; res.statusCode = 400; return res.end(JSON.stringify({ name: 'BadRequest', data: { message: 'Expected JSON value, got undefined at metadata.path' } })); }
    if (req.url === '/session/ses_handoff/message' && req.method === 'GET') return res.end(JSON.stringify([{ parts: [
      { type: 'tool', callID: 'native_bash', tool: 'bash', state: { status: 'running', input: { command: 'ls /tmp', description: 'list the directory' } } }] }]));
    if (req.url === '/session/ses_handoff/message') { waiting = true; return; }
    res.end('true');
  });
  const backend = new Backend(await listen(fake), 'test');
  backend.handleEvent({ type: 'permission.asked', properties: { id: 'per_bash', sessionID: 'ses_handoff', permission: 'grep', metadata: {}, tool: { callID: 'native_bash' } } });
  // The event stream reports the blocked call; the approval only carries its call ID.
  backend.toolParts.set('native_bash', { tool: 'bash', input: { command: 'ls /tmp', description: 'list the directory' } });
  try {
    const result = await backend.complete(prepare({ model: models[0].id, messages: body.messages, tools: [bashTool] }, models));
    const call = result.choices[0].message.tool_calls[0];
    assert.equal(call.function.name, 'Bash');
    assert.ok(polls >= 1);
    assert.equal(backend.pendingApprovals.size, 0, 'Session cleanup removes cached approvals');
    assert.deepEqual(JSON.parse(call.function.arguments), { command: 'ls /tmp', description: 'list the directory' });
    assert.ok(events.includes('POST /session/ses_handoff/abort'), 'The generation is stopped once the action is handed over');
  } finally { backend.stopEvents(); fake.closeAllConnections(); fake.close(); }
});

test('usage includes cached input and reasoning output without double counting total', () => {
  const result = completion(body.model, { role: 'assistant', content: 'OK' },
    { input: 100, output: 20, reasoning: 30, cache: { read: 900, write: 50 }, total: 1100 });
  assert.equal(result.usage.prompt_tokens, 1050);
  assert.equal(result.usage.completion_tokens, 50);
  assert.equal(result.usage.total_tokens, 1100);
  assert.equal(result.usage.prompt_tokens_details.cached_tokens, 900);
  assert.equal(result.usage.completion_tokens_details.reasoning_tokens, 30);
});
test('missing usage is not reported as zero in JSON or SSE', () => {
  const result = completion(body.model, { role: 'assistant', content: 'OK' });
  assert.equal(result.usage, undefined);
  let text = '';
  sendSSE({ write: s => { text += s; }, end: s => { text += s; } }, result, true);
  assert.ok(!text.includes('"usage"'));
  assert.ok(text.endsWith('data: [DONE]\n\n'));
});
test('native handoff returns recorded session usage instead of zero', async () => {
  const backend = new Backend('http://unused', 'test');
  const events = [];
  backend.pendingPermissions = async () => [{ id: 'per_usage', sessionID: 'ses_usage' }];
  backend.handlePermission = async () => ({ handoff: { name: 'Read', arguments: { file_path: '/tmp/file' } } });
  backend.request = async (route, method) => {
    events.push([route, method]);
    if (route === '/session') return { id: 'ses_usage' };
    if (route.endsWith('/message?limit=1')) return [{ info: { role: 'assistant', tokens: {
      input: 100, output: 25, reasoning: 5, cache: { read: 2000, write: 100 },
    } } }];
    if (route.endsWith('/message')) return new Promise(() => {});
    return true;
  };
  const result = await backend.complete(prepare(body, models));
  assert.equal(result.usage.prompt_tokens, 2200);
  assert.equal(result.usage.completion_tokens, 30);
  assert.ok(events.findIndex(([r]) => r.endsWith('/abort')) < events.findIndex(([r]) => r.endsWith('/message?limit=1')));
});

test('handoff usage falls back to its session event and is cleared after completion', async () => {
  const backend = new Backend('http://unused', 'test');
  backend.pendingPermissions = async () => [{ id: 'per_usage', sessionID: 'ses_usage' }];
  backend.handlePermission = async () => ({ handoff: { name: 'Read', arguments: { file_path: '/tmp/file' } } });
  backend.request = async route => {
    if (route === '/session') return { id: 'ses_usage' };
    if (route.endsWith('/abort')) {
      backend.handleEvent({ type: 'message.updated', properties: { info: {
        role: 'assistant', sessionID: 'ses_usage', tokens: { input: 1234, output: 5 },
      } } });
    }
    if (route.endsWith('/message?limit=1')) throw new Error('message lookup failed');
    if (route.endsWith('/message')) return new Promise(() => {});
    return true;
  };
  const result = await backend.complete(prepare(body, models));
  assert.equal(result.usage.prompt_tokens, 1234);
  assert.equal(backend.usageBySession.size, 0);
  backend.handleEvent({ type: 'message.updated', properties: { info: {
    role: 'assistant', sessionID: 'ses_usage', tokens: { input: 9999 },
  } } });
  assert.equal(backend.usageBySession.size, 0, 'Late events do not resurrect completed session usage');
});

test('JSON-encoded calls arrays are decoded without weakening tool validation', () => {
  const request = prepare(body, models);
  const content = '正文保持不变';
  const args = { path: 'a', content: 'line 1\n"quoted"\\value' };
  const encoded = calls => JSON.stringify({ content, calls: JSON.stringify(calls) });
  const result = decode(encoded([{ name: 'write_file', arguments: JSON.stringify(args) }]), request);
  assert.equal(result.content, content);
  assert.deepEqual(JSON.parse(result.tool_calls[0].function.arguments), args);
  assert.equal(decode(encoded([]), request).content, content);
  assert.throws(() => decode(encoded([{ name: 'unknown', arguments: {} }]), request), /unlisted/);
  assert.throws(() => decode(encoded([{ name: 'write_file', arguments: args }]), prepare({ ...body, tool_choice: 'none' }, models)), /none/);
  for (const calls of ['', 'not json', '{}', 'null', '"[]"']) {
    assert.throws(() => decode(JSON.stringify({ content, calls }), request), /envelope/);
  }
});

test('probes subscribe to tool events even without a UI activity callback', async () => {
  const backend = new Backend('http://unused', 'test');
  let watching = false, stopped = false;
  backend.watchEvents = () => { watching = true; };
  backend.stopEvents = () => { stopped = true; };
  backend.request = async route => {
    if (route === '/session') return { id: 'ses_probe_events' };
    if (route.endsWith('/message')) {
      assert.equal(watching, true, 'Tool events must be observed before model inference');
      return { info: {}, parts: [{ type: 'text', text: '{"content":"OK","calls":[]}' }] };
    }
    return [];
  };
  await backend.complete(prepare(body, models), undefined, { probe: true });
  assert.equal(stopped, true, 'Release the subscription when the last session ends');
});

test('manual runtime update waits for idle requests and blocks mutations while updating', async () => {
  let finish, entered, updates = 0, phase = 'ready';
  const started = new Promise(resolve => { entered = resolve; });
  const pending = new Promise(resolve => { finish = resolve; });
  const server = createServer({ key: 'test', getModels: () => models, status: () => ({ phase }),
    backend: { complete: async r => { entered(); await pending; return completion(r.model.id, { role: 'assistant', content: 'OK' }); } },
    updateRuntime: async () => { updates++; return { changed: false, version: '2.0.32' }; } });
  const base = await listen(server);
  const headers = { Authorization: 'Bearer test', 'Content-Type': 'application/json' };
  const post = route => fetch(base + route, { method: 'POST', headers });
  try {
    assert.equal((await fetch(base + '/admin/update-runtime', { method: 'POST' })).status, 401);
    const running = fetch(base + '/v1/chat/completions', { method: 'POST', headers, body: JSON.stringify(body) });
    await started;
    assert.equal((await post('/admin/update-runtime')).status, 409);
    assert.equal(updates, 0);
    finish(); await (await running).text();
    assert.equal((await post('/admin/update-runtime')).status, 200);
    assert.equal(updates, 1);
    phase = 'updating';
    for (const route of ['/admin/update-runtime', '/admin/refresh', '/v1/chat/completions']) assert.equal((await post(route)).status, 409);
  } finally { finish(); server.closeAllConnections(); server.close(); }
});

test('HTTP uses explicit conversation and purpose headers locally; absent headers do not infer identity', async () => {
  const requests = [];
  const server = createServer({ key: 'test', backend: { complete: async r => {
    requests.push(r); return completion(r.model.id, { role: 'assistant', content: 'OK' });
  } }, getModels: () => models, status: () => ({ phase: 'ready' }) });
  const base = await listen(server);
  try {
    for (const extra of [{}, { 'X-Conversation-ID': 'one' }, { 'X-Conversation-ID': 'one' },
      { 'X-Conversation-ID': 'two' }, { 'X-Conversation-ID': 'one', 'X-Agent-Purpose': 'subtask' }]) {
      const response = await fetch(base + '/v1/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(body) });
      assert.equal(response.status, 200); await response.json();
    }
    assert.equal(requests[0].conversationKey, undefined);
    assert.equal(requests[1].conversationKey, requests[2].conversationKey);
    assert.notEqual(requests[1].conversationKey, requests[3].conversationKey);
    assert.notEqual(requests[1].conversationKey, requests[4].conversationKey);
    assert.equal(requests[1].conversationKey.length, 64);
  } finally { server.closeAllConnections(); server.close(); }
});
