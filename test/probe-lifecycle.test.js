import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PROBE_CACHE_TTL } from '../src/probe-policy.js';

async function fixture(t, catalog) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ow-probe-policy-'));
  const writeCatalog = () => fs.writeFile(path.join(root, 'catalog.json'), JSON.stringify(catalog));
  await writeCatalog();
  let child, exited, port, logs = '';
  async function stop() {
    if (child?.exitCode === null) { child.send('shutdown'); await exited; }
  }
  t.after(async () => { await stop(); await fs.rm(root, { recursive: true, force: true }); });
  async function waitFor(predicate) {
    for (let i = 0; i < 250; i++) {
      const state = await fs.readFile(path.join(root, 'status.json'), 'utf8').then(JSON.parse).catch(() => null);
      if (state?.pid === child.pid && predicate(state)) return state;
      if (child.exitCode !== null) throw new Error(logs);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('Timeout: ' + logs);
  }
  async function start() {
    const socket = net.createServer();
    await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
    port = socket.address().port; await new Promise(resolve => socket.close(resolve));
    child = spawn(process.execPath, ['--loader', new URL('./fixtures/runtime-loader.mjs', import.meta.url).href, 'src/main.js'], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { ...process.env, BUDDY_DATA_DIR: root, BUDDY_PORT: String(port), BUDDY_MODELS_FILE: path.join(root, 'models.json'), BUDDY_NO_SYNC: '1' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    child.stdout.on('data', x => logs += x); child.stderr.on('data', x => logs += x);
    exited = new Promise(resolve => child.once('exit', resolve));
    return waitFor(s => s.phase === 'ready' && s.sync?.time && !s.probe.running);
  }
  async function post(route, body = {}) {
    const key = (await fs.readFile(path.join(root, 'api-key'), 'utf8')).trim();
    const response = await fetch(`http://127.0.0.1:${port}/admin/${route}`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const result = await response.json(); assert.ok(response.ok, JSON.stringify(result)); return result;
  }
  const requests = async () => (await fs.readFile(path.join(root, 'requests.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse);
  async function api(route, body) {
    const key = (await fs.readFile(path.join(root, 'api-key'), 'utf8')).trim();
    return fetch(`http://127.0.0.1:${port}/v1/${route}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  }
  return { root, start, stop, post, api, requests, waitFor, writeCatalog };
}
const catalog = () => ({ models: [{ id: 'opencode/a', name: 'A' }, { id: 'opencode/b', name: 'B' }, { id: 'opencode/c', name: 'C' }], failed: [] });

test('real service stops on first 403, persists cooldown over two restarts, and confirms manual bypass', async t => {
  const data = catalog(); data.gatewayErrors = { 'opencode/a': { status: 403 } };
  const f = await fixture(t, data);
  await f.start(); assert.equal((await f.requests()).length, 0, 'No full catalog probe on startup');
  await f.post('probe');
  let state = await f.waitFor(s => s.probeBlockedUntil > Date.now() && !s.probe.running);
  assert.deepEqual((await f.requests()).map(r => r.model), ['opencode/a']);
  assert.deepEqual(state.pendingModels, ['opencode/b', 'opencode/c']);
  assert.equal(state.modelResults['opencode/a'].status, 403);
  assert.equal(state.modelResults['opencode/b'], undefined);
  const until = state.probeBlockedUntil;
  for (let i = 0; i < 2; i++) {
    await f.stop(); state = await f.start();
    assert.equal(state.probeBlockedUntil, until);
    await f.post('refresh'); await f.post('system-proxy', { enabled: false });
    assert.equal((await f.requests()).length, 1);
  }
  assert.equal((await f.post('probe')).confirmationRequired, true);
  assert.equal((await f.requests()).length, 1);
  assert.equal((await f.post('probe', { confirmed: true })).started, true);
  await f.waitFor(s => !s.probe.running && s.probeBlockedUntil > until);
  assert.equal((await f.requests()).length, 2);
});

test('chat fallback 429 also stops the entire batch', async t => {
  const data = catalog(); data.chatOnly = ['opencode/a']; data.gatewayErrors = { 'opencode/a': { status: 429, chatOnly: true } };
  const f = await fixture(t, data); await f.start(); await f.post('probe');
  const state = await f.waitFor(s => !s.probe.running && s.probeBlockedUntil > Date.now());
  assert.deepEqual((await f.requests()).map(r => [r.model, r.chatOnly]), [['opencode/a', false], ['opencode/a', true]]);
  assert.deepEqual(state.pendingModels, ['opencode/b', 'opencode/c']);
});

test('catalog refresh and proxy changes never infer; manual detection refreshes changed and expired cache', async t => {
  const data = catalog(); const f = await fixture(t, data);
  await f.start(); await f.post('probe');
  await f.waitFor(s => !s.probe.running && s.modelResults['opencode/c']?.ok);
  const initial = (await f.requests()).length;
  await f.post('refresh'); assert.equal((await f.requests()).length, initial);
  data.models[1].images = true; data.models.push({ id: 'opencode/d', name: 'D' }); await f.writeCatalog();
  await f.post('refresh');
  assert.equal((await f.requests()).length, initial);
  await f.post('system-proxy', { enabled: false });
  assert.equal((await f.requests()).length, initial);
  await f.post('probe');
  await f.waitFor(s => !s.probe.running && s.modelResults['opencode/d']?.ok);
  assert.deepEqual((await f.requests()).slice(initial).map(r => r.model), ['opencode/a', 'opencode/b', 'opencode/c', 'opencode/d']);
  await f.stop();
  const file = path.join(f.root, 'status.json'), saved = JSON.parse(await fs.readFile(file, 'utf8'));
  saved.modelResults['opencode/a'].time = new Date(Date.now() - PROBE_CACHE_TTL - 1000).toISOString();
  await fs.writeFile(file, JSON.stringify(saved));
  const before = (await f.requests()).length;
  const state = await f.start();
  assert.equal((await f.requests()).length, before);
  assert.equal(state.availableModels.length, 4);
  assert.ok(state.pendingModels.includes('opencode/a'));
  await f.post('refresh');
  assert.equal((await f.requests()).length, before);
  await f.post('probe', { model: 'opencode/a' });
  await f.waitFor(s => !s.probe.running && Date.parse(s.modelResults['opencode/a']?.time) > Date.parse(saved.modelResults['opencode/a'].time));
  assert.deepEqual((await f.requests()).slice(before).map(r => r.model), ['opencode/a']);
});


test('a timed-out probe never removes a model from the API or import, including after restart', async t => {
  const data = catalog(); data.probeTimeout = true;
  const f = await fixture(t, data); await f.start();
  await f.post('probe', { model: 'opencode/a' });
  const state = await f.waitFor(s => !s.probe.running && s.modelResults['opencode/a']?.code === 'timeout');
  assert.equal(state.availableModels.length, 3);
  assert.equal((await f.post('import')).count, 3);
  await f.stop();
  assert.equal((await f.start()).availableModels.length, 3);
  assert.equal((await f.requests()).length, 1, 'Restart does not infer');
  const listed = await (await f.api('models')).json();
  assert.equal(listed.data.length, 3);
  const response = await f.api('chat/completions', { model: 'OC · A', messages: [{ role: 'user', content: 'Hello' }] });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).choices[0].message.content, 'OK');
});
