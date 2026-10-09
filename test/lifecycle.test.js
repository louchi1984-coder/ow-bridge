import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { OWNER } from '../src/sync.js';

test('startup imports once; repeated checks and reads require import; exit removes owned models', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'buddy-lifecycle-'));
  const config = path.join(root, 'models.json');
  const manual = { id: 'personal', apiKey: 'keep' };
  await fs.writeFile(config, JSON.stringify([manual, { id: 'old-owned', buddyBridgeOwner: OWNER }]));
  const catalog = { models: [{ id: 'opencode/a', name: 'A' }, { id: 'opencode/b', name: 'B' }], failed: [] };
  const writeCatalog = () => fs.writeFile(path.join(root, 'catalog.json'), JSON.stringify(catalog));
  await writeCatalog();
  await fs.writeFile(path.join(root, 'service.pid'), String(process.pid));
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const child = spawn(process.execPath, ['--loader', new URL('./fixtures/runtime-loader.mjs', import.meta.url).href, 'src/main.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { ...process.env, BUDDY_DATA_DIR: root, BUDDY_PORT: String(port), BUDDY_MODELS_FILE: config, BUDDY_NO_SYNC: '0' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let logs = ''; child.stdout.on('data', x => logs += x); child.stderr.on('data', x => logs += x);
  const exited = new Promise(resolve => child.once('exit', resolve));
  async function waitFor(predicate) {
    for (let i = 0; i < 300; i++) {
      let state;
      try { state = JSON.parse(await fs.readFile(path.join(root, 'status.json'), 'utf8')); } catch {}
      if (state && predicate(state)) return state;
      if (child.exitCode !== null) throw new Error(logs);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('Lifecycle timeout: ' + logs);
  }
  try {
    await waitFor(s => s.probe.running);
    assert.deepEqual(JSON.parse(await fs.readFile(config, 'utf8')), [manual], 'Startup clears old owned entries before detection');
    await waitFor(s => s.phase === 'ready' && !s.probe.running);
    const initial = await fs.readFile(config, 'utf8');
    const backups = async () => (await fs.readdir(root)).filter(name => name.endsWith('.bak')).length;
    assert.equal(await backups(), 2, 'One startup cleanup and one import after the full batch');
    assert.deepEqual(JSON.parse(initial).map(m => m.id), ['personal', 'OC · A', 'OC · B']);
    const key = (await fs.readFile(path.join(root, 'api-key'), 'utf8')).trim();
    async function post(route, payload = {}) {
      const response = await fetch(`http://127.0.0.1:${port}/admin/${route}`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      assert.ok(response.ok, await response.text());
    }
    async function checkTranslator(expected) {
      catalog.checkTranslator = true; await writeCatalog();
      const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'OC · A', messages: [{ role: 'user', content: 'Hello' }] }) });
      assert.equal((await response.json()).choices[0].message.content, expected);
      catalog.checkTranslator = false; await writeCatalog();
    }
    await checkTranslator('opencode/b');
    catalog.formatError = true; await writeCatalog();
    const failedResponse = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'OC · A', messages: [{ role: 'user', content: 'Hello' }] }) });
    assert.equal(failedResponse.status, 502);
    const afterFormatError = await waitFor(s => s.lastRequest?.code === 'invalid_model_output');
    assert.ok(afterFormatError.availableModels.includes('opencode/a'));
    assert.equal(afterFormatError.modelResults['opencode/a'].ok, true);
    assert.equal(await fs.readFile(config, 'utf8'), initial);
    catalog.formatError = false;
    catalog.failed = ['opencode/b']; await writeCatalog();
    await post('probe');
    await waitFor(s => !s.probe.running && s.modelResults['opencode/b']?.ok === false);
    assert.equal(await fs.readFile(config, 'utf8'), initial, 'Manual detection never writes WorkBuddy');
    await post('refresh');
    await waitFor(s => s.probe.running);
    await waitFor(s => s.phase === 'ready' && !s.probe.running && s.models.length === 2);
    assert.equal(await fs.readFile(config, 'utf8'), initial, 'Manual reading never writes WorkBuddy');
    await post('system-proxy', { enabled: false });
    await waitFor(s => s.probe.running);
    await waitFor(s => s.phase === 'ready' && !s.probe.running);
    await checkTranslator('none');
    assert.equal(JSON.parse(await fs.readFile(path.join(root, 'settings.json'), 'utf8')).useSystemProxy, false);
    assert.equal(await fs.readFile(config, 'utf8'), initial, 'Network mode changes do not import models');
    assert.equal(await backups(), 2, 'Repeated checks and reads produce no config writes');
    await post('import');
    assert.deepEqual(JSON.parse(await fs.readFile(config, 'utf8')).map(m => m.id), ['personal', 'OC · A']);
    catalog.failed = []; catalog.chatOnly = ['opencode/b']; await writeCatalog();
    await post('probe');
    await waitFor(s => s.probe.running);
    await waitFor(s => !s.probe.running && s.modelResults['opencode/b']?.chatOnly);
    await post('import');
    const imported = JSON.parse(await fs.readFile(config, 'utf8'));
    assert.deepEqual(imported.map(m => m.id), ['personal', 'OC · A', 'OC · B']);
    assert.equal(imported[2].supportsToolCall, false);
    await post('selection', { model: 'opencode/b', selected: false });
    assert.equal(await fs.readFile(config, 'utf8'), JSON.stringify(imported, null, 2) + '\n', 'Selection does not write WorkBuddy');
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'settings.json'), 'utf8')).excludedModels, ['opencode/b']);
    await post('import');
    assert.deepEqual(JSON.parse(await fs.readFile(config, 'utf8')).map(m => m.id), ['personal', 'OC · A']);
    await post('selection', { model: 'opencode/a', selected: false });
    await post('import');
    assert.deepEqual(JSON.parse(await fs.readFile(config, 'utf8')), [manual], 'Empty selection removes only managed entries');
    await post('selection', { model: 'opencode/a', selected: true });
    await post('selection', { model: 'opencode/b', selected: true });
    const alternate = path.join(root, 'custom', 'models.json');
    await fs.mkdir(path.dirname(alternate));
    await fs.writeFile(alternate, JSON.stringify([manual]));
    await post('import', { modelsFile: alternate });
    assert.deepEqual(JSON.parse(await fs.readFile(config, 'utf8')), [manual], 'Switching location clears only previously managed entries');
    assert.equal(JSON.parse(await fs.readFile(alternate, 'utf8')).length, 3);
    assert.equal(JSON.parse(await fs.readFile(path.join(root, 'settings.json'), 'utf8')).workBuddyModelsFile, alternate);
    await fs.unlink(alternate);
    await post('import', { modelsFile: config });
    assert.equal(JSON.parse(await fs.readFile(config, 'utf8')).length, 3, 'A moved or deleted old file does not block choosing another configuration');
    await post('probe');
    await waitFor(s => s.probe.running);
    child.send('shutdown'); await exited;
    await assert.rejects(fs.stat(alternate), { code: 'ENOENT' });
    assert.deepEqual(JSON.parse(await fs.readFile(config, 'utf8')), [manual], 'Exit cleans the selected configuration');
  } finally {
    if (child.exitCode === null) { child.send('shutdown'); await exited; }
    await fs.rm(root, { recursive: true, force: true });
  }
});
