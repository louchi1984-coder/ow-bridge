const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, dialog } = require('electron');
const { fork, execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const { createWriteStream } = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { activityText } = require('./activity.cjs');

app.setName('OW Bridge');
app.setAppUserModelId('local.buddy.bridge');
let window, tray, service, timer, log, quitting = false, mayQuit = false, actionBusy = false;
let state = { phase: 'starting', message: '正在启动隔离模型服务', models: [], modelResults: {} };
let dataDir, lastMenu = '';
const page = pathToFileURL(path.join(__dirname, 'index.html')).href;

function showWindow() {
  if (!window) {
    window = new BrowserWindow({ width: 1040, height: 740, minWidth: 880, minHeight: 620, title: 'OW Bridge', backgroundColor: '#ffffff',
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true } });
    window.setMenu(null);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.on('did-finish-load', publish);
    window.on('close', event => { if (!mayQuit) { event.preventDefault(); window.hide(); } });
    window.on('blur', () => window.webContents.send('dismiss-details'));
    window.on('session-end', () => app.quit());
    window.loadFile(path.join(__dirname, 'index.html'));
  }
  window.show(); window.focus();
}
function activityLabel(s) {
  const a = (s.activity || [])[0];
  if (!a) return s.probe?.running ? '正在检测模型…' : s.message || '正在启动…';
  return activityText(a);
}
function publish() {
  if (window && !window.isDestroyed()) window.webContents.send('state', { ...state, actionBusy });
  if (!tray) return;
  const signature = JSON.stringify([state, actionBusy]);
  if (signature === lastMenu) return;
  lastMenu = signature;
  const available = new Set(state.availableModels || []);
  const busy = actionBusy || state.configSearch?.running || state.probe?.running || state.phase !== 'ready';
  tray.setToolTip('OW Bridge');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: activityLabel(state), enabled: false },
    { label: '打开控制面板', click: showWindow }, { type: 'separator' },
    { label: '重新扫描免费模型', enabled: !busy, click: () => trayAction('refresh') },
    { label: '检测全部模型', enabled: !busy, click: () => trayAction('probe') },
    { label: '导入 WorkBuddy', enabled: !busy, click: () => trayAction('import') },
    ...(process.platform === 'win32' ? [{ label: '自动查找 WorkBuddy 配置…', enabled: !busy, click: () => trayAction('find-config') }, { label: '选择 WorkBuddy 配置…', enabled: !busy, click: () => trayAction('choose-config') }] : []),
    { label: '模型状态', submenu: (state.models || []).map(m => ({ label: `OC · ${m.name} · ${available.has(m.id) ? state.modelResults?.[m.id]?.chatOnly ? '可用 · 仅对话' : '可用' : '不可用'}`, enabled: false })) },
    { type: 'separator' }, { label: '退出 OW Bridge', click: () => app.quit() },
  ]));
}
async function readState() {
  try {
    const value = JSON.parse(await fs.readFile(path.join(dataDir, 'status.json'), 'utf8'));
    if (value.pid === service?.pid && !quitting) { state = value; publish(); }
  } catch {}
}
async function action(name, value) {
  if (!['refresh', 'probe', 'import', 'system-proxy', 'restart', 'choose-config', 'find-config', 'selection'].includes(name)) throw new Error('未知操作');
  if (state.configSearch?.running) throw new Error('请等待配置查找完成');
  if (actionBusy) throw new Error('请等待当前操作完成');
  if (name === 'restart') {
    actionBusy = name; publish();
    try { await stopService(); state = { phase: 'starting', message: '正在启动隔离模型服务', models: [], modelResults: {} }; await startService(); return {}; }
    finally { actionBusy = false; publish(); }
  }
  if ((state.phase !== 'ready' && !(name === 'system-proxy' && state.phase === 'error')) || state.probe?.running) throw new Error('请等待服务启动和检测完成');
  if (name === 'system-proxy' && typeof value !== 'boolean') throw new Error('代理开关必须为布尔值');
  actionBusy = name; publish();
  try {
    let modelsFile;
    if (process.platform === 'win32' && (name === 'find-config' || (name === 'import' && (!state.modelsFile || !(await fs.stat(state.modelsFile).catch(() => null))?.isFile())))) {
      let found = state.configSearch;
      if (name === 'find-config' || !found?.candidates?.length) {
        const key = (await fs.readFile(path.join(dataDir, 'api-key'), 'utf8')).trim();
        const response = await fetch(`http://127.0.0.1:${Number(process.env.BUDDY_PORT || 41980)}/admin/find-config`, {
          method: 'POST', headers: { Authorization: `Bearer ${key}` } });
        found = await response.json();
        if (!response.ok) throw new Error(found.error?.message || '自动查找失败');
      }
      const candidates = found.candidates || [];
      if (candidates.length) {
        modelsFile = candidates[0];
      } else {
        await dialog.showMessageBox({ type: 'info', message: found.errors?.length ? '自动查找未完成，请手动选择' : '自动查找未找到配置，请手动选择',
          detail: found.errors?.join('\n') || '请先在 WorkBuddy 保存一个自定义模型，再重试。' });
      }
      name = modelsFile ? 'import' : 'choose-config';
    }
    if (process.platform === 'win32' && name === 'choose-config') {
      const selection = await dialog.showOpenDialog({ title: '选择 WorkBuddy 的 models.json', message: '请选择 WorkBuddy 实际使用的配置文件。首次使用请先在 WorkBuddy 保存一个自定义模型。', properties: ['openFile'], filters: [{ name: 'JSON 配置', extensions: ['json'] }] });
      if (selection.canceled || !selection.filePaths.length) return { canceled: true };
      modelsFile = selection.filePaths[0];
      name = 'import';
    }
    const key = (await fs.readFile(path.join(dataDir, 'api-key'), 'utf8')).trim();
    const endpoint = `http://127.0.0.1:${Number(process.env.BUDDY_PORT || 41980)}`;
    const response = await fetch(`${endpoint}/admin/${name}`, { method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(name === 'system-proxy' ? { enabled: value } : name === 'selection' ? value : modelsFile ? { modelsFile } : {}), signal: AbortSignal.timeout(150000) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error?.message || `HTTP ${response.status}`);
    await readState();
    return result;
  } finally { actionBusy = false; publish(); }
}
async function trayAction(name) {
  try {
    const result = await action(name);
    if (['import', 'choose-config', 'find-config'].includes(name) && !result.canceled) await dialog.showMessageBox({ type: 'info', title: 'OW Bridge', message: '导入完成', detail: importMessage(result) });
  } catch (e) { await dialog.showMessageBox({ type: 'error', title: 'OW Bridge', message: '操作失败', detail: e.message }); }
}
function importMessage(result) {
  return result.changed === false ? `WorkBuddy 配置已是最新，共 ${result.count} 个模型，无需重复写入。` : `已将 ${result.count} 个可用模型导入 WorkBuddy。`;
}
async function startService() {
  await fs.mkdir(dataDir, { recursive: true });
  log = createWriteStream(path.join(dataDir, 'app.log'), { flags: 'a' });
  service = fork(path.join(__dirname, '..', 'src', 'main.js'), [], { execPath: process.execPath, execArgv: [],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', BUDDY_DATA_DIR: dataDir }, cwd: dataDir, windowsHide: true, silent: true });
  service.stdout.pipe(log, { end: false }); service.stderr.pipe(log, { end: false });
  service.on('error', error => { state = { ...state, phase: 'error', message: error.message }; publish(); });
  service.on('exit', code => {
    if (!quitting) { state = { ...state, phase: 'error', message: `服务已退出（${code}），请退出后重新启动应用` }; publish(); }
  });
  timer = setInterval(readState, 500);
}
async function stopService() {
  clearInterval(timer);
  if (service && service.exitCode === null && service.signalCode === null) {
    const exited = new Promise(resolve => service.once('exit', resolve));
    if (service.connected) service.send('shutdown', () => {});
    const finished = await Promise.race([exited.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 20000))]);
    if (!finished) {
      if (process.platform === 'win32') await new Promise(resolve => execFile('taskkill.exe', ['/PID', String(service.pid), '/T', '/F'], { windowsHide: true }, resolve));
      else service.kill('SIGKILL');
    }
  }
  log?.end();
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', showWindow);
  app.on('activate', showWindow);
  app.on('window-all-closed', () => {});
  app.on('before-quit', event => {
    if (mayQuit) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    stopService().finally(() => { mayQuit = true; app.quit(); });
  });
  app.whenReady().then(async () => {
    const { dataDirectory } = await import('../src/platform.js');
    dataDir = process.env.BUDDY_DATA_DIR || dataDirectory();
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'OW Bridge', submenu: [{ label: '退出 OW Bridge', role: 'quit' }] }, { label: '编辑', submenu: [{ label: '复制', role: 'copy' }, { label: '全选', role: 'selectAll' }] }]));
    app.setPath('userData', dataDir);
    ipcMain.handle('action', async (event, name, value) => {
      if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== page) throw new Error('拒绝未知来源');
      try {
        const result = await action(name, value);
        if (name === 'import' && !result.canceled) await dialog.showMessageBox(window, {
          type: 'info', title: 'OW Bridge', message: result.changed === false ? '配置已是最新' : '导入完成',
          detail: importMessage(result), buttons: ['确定'], defaultId: 0, cancelId: 0,
        });
        return { ok: true, result };
      } catch (error) {
        if (name === 'import') await dialog.showMessageBox(window, {
          type: 'error', title: 'OW Bridge', message: '导入失败', detail: error.message, buttons: ['确定'], defaultId: 0, cancelId: 0,
        });
        return { ok: false, error: error.message };
      }
    });
    const trayIcon = nativeImage.createFromPath(path.join(__dirname, process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png'));
    if (process.platform === 'darwin') trayIcon.setTemplateImage(true);
    tray = new Tray(trayIcon);
    tray.on('click', showWindow);
    showWindow(); publish(); await startService();
  }).catch(error => { dialog.showErrorBox('启动失败', error.message); app.quit(); });
}
