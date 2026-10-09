import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

test('hard-killed service and reused PID recover; a live second instance cannot touch shared state', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ow-crash-'));
  const config = path.join(root, 'models.json');
  await fs.writeFile(config, '[]');
  await fs.writeFile(path.join(root, 'catalog.json'), JSON.stringify({ models: [{ id: 'opencode/a', name: 'A' }], failed: [] }));
  await fs.writeFile(path.join(root, 'settings.json'), JSON.stringify({ useSystemProxy: false, excludedModels: ['opencode/a'] }));
  const socket = net.createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const port = socket.address().port; await new Promise(r => socket.close(r));
  const children = [];
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) { const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit; }
    await fs.rm(root, { recursive: true, force: true });
  });
  const start = () => {
    const child = spawn(process.execPath, ['--loader', new URL('./fixtures/runtime-loader.mjs', import.meta.url).href, 'src/main.js'], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { ...process.env, BUDDY_DATA_DIR: root, BUDDY_PORT: String(port), BUDDY_MODELS_FILE: config, BUDDY_NO_SYNC: '0' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    child.logs = ''; child.stdout.on('data', x => child.logs += x); child.stderr.on('data', x => child.logs += x);
    children.push(child); return child;
  };
  const ready = async child => {
    for (let i = 0; i < 500; i++) {
      const state = await fs.readFile(path.join(root, 'status.json'), 'utf8').then(JSON.parse, () => null);
      if (state?.pid === child.pid && state.phase === 'ready' && !state.probe.running) return;
      if (child.exitCode !== null) throw new Error(child.logs);
      await new Promise(r => setTimeout(r, 20));
    }
    throw new Error(child.logs);
  };
  let child = start(); await ready(child);
  const before = await fs.readFile(config, 'utf8');
  assert.deepEqual(JSON.parse(before), [], 'Startup respects saved model selection');
  const second = start(); const [code] = await once(second, 'exit');
  assert.notEqual(code, 0); assert.match(second.logs, /已被占用/);
  assert.equal(await fs.readFile(path.join(root, 'service.pid'), 'utf8'), String(child.pid));
  assert.equal(await fs.readFile(config, 'utf8'), before);
  const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit;
  // Simulate the OS reassigning the dead service PID to a live unrelated process.
  await fs.writeFile(path.join(root, 'service.pid'), String(process.pid));
  child = start(); await ready(child);
  assert.equal(await fs.readFile(path.join(root, 'service.pid'), 'utf8'), String(child.pid));
  assert.deepEqual(JSON.parse(await fs.readFile(config, 'utf8')), []);
  const stopped = once(child, 'exit'); child.send('shutdown'); await stopped;
  await assert.rejects(fs.access(path.join(root, 'service.pid')), { code: 'ENOENT' });
});
