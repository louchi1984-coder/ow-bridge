import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const entry = new URL('../desktop/main.cjs', import.meta.url);
const require = createRequire(entry);

test('early activation and second-instance events wait for Electron readiness', () => {
  let ready = false, created = 0, shown = 0;
  const app = Object.assign(new EventEmitter(), {
    setName() {}, setAppUserModelId() {}, requestSingleInstanceLock: () => true,
    isReady: () => ready, whenReady: () => new Promise(() => {}), quit() {},
  });
  class BrowserWindow extends EventEmitter {
    constructor() {
      super();
      if (!ready) throw new Error('Cannot create BrowserWindow before app is ready');
      created++;
      this.webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler() {} });
    }
    setMenu() {} loadFile() {} show() { shown++; } focus() {}
  }
  vm.runInNewContext(fs.readFileSync(entry, 'utf8'), {
    require: name => name === 'electron' ? { app, BrowserWindow } : require(name),
    __dirname: path.dirname(fileURLToPath(entry)), process, clearInterval, setTimeout,
  });
  assert.doesNotThrow(() => app.emit('activate'));
  assert.doesNotThrow(() => app.emit('second-instance'));
  assert.equal(created, 0);
  ready = true;
  app.emit('activate'); app.emit('second-instance');
  assert.equal(created, 1);
  assert.equal(shown, 2);
});

test('manual model detection sends a single request without a confirmation dialog', async () => {
  for (const attempt of [0, 1]) {
    const app = Object.assign(new EventEmitter(), {
      setName() {}, setAppUserModelId() {}, requestSingleInstanceLock: () => true,
      isReady: () => false, whenReady: () => new Promise(() => {}), quit() {},
    });
    const bodies = []; let dialogs = 0;
    const context = {
      require: name => name === 'electron' ? { app, dialog: { showMessageBox: async options => {
        dialogs++; assert.fail('Detection must not ask for cooldown confirmation');
      } } } : name === 'node:fs/promises' ? { readFile: async file => {
        if (file.endsWith('api-key')) return 'test-key'; throw new Error('No status update');
      } } : require(name),
      fetch: async (_, options) => {
        bodies.push(JSON.parse(options.body));
        return { ok: true, json: async () => ({ started: true }) };
      },
      __dirname: path.dirname(fileURLToPath(entry)), process, clearInterval, setTimeout, AbortSignal,
    };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(entry, 'utf8') + '\nstate = { phase: "ready" }; dataDir = "/tmp/ow-dialog-test"; globalThis.invokeProbe = () => action("probe", { model: "opencode/a" });', context);
    const result = await context.invokeProbe();
    assert.equal(dialogs, 0);
    assert.deepEqual(bodies, [{ model: "opencode/a" }]);
    assert.equal(result.started, true);
  }
});
