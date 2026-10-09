const $ = id => document.getElementById(id);
let state = {}, selected = null, pendingAction = false, lastModels = '';
function element(tag, className, text) {
  const el = document.createElement(tag); if (className) el.className = className; if (text !== undefined) el.textContent = text; return el;
}
function waiting(id) { return state.probe?.running && state.probe?.pending?.includes(id); }
function label(model) {
  if (waiting(model.id)) return state.probe.current === model.id ? '检测中' : '等待检测';
  if ((state.activity || []).some(a => a.model === model.id)) return '请求中';
  const r = state.modelResults?.[model.id];
  if (state.availableModels?.includes(model.id)) return r?.chatOnly ? '可用 · 仅对话' : '可用';
  return ({ timeout: '检测超时', quota: '额度不足', rate_limit: '请求受限', access: '访问受限' })[r?.category] || (r?.ok === false ? '不可用' : '待检测');
}
function rank(model) { return waiting(model.id) ? 1 : state.availableModels?.includes(model.id) ? 0 : state.modelResults?.[model.id]?.ok === false ? 2 : 1; }
function timing(id) {
  const r = state.modelResults?.[id]; if (!Number.isFinite(r?.durationMs)) return '响应耗时 —';
  const duration = r.durationMs < 1000 ? `${r.durationMs} ms` : `${(r.durationMs / 1000).toFixed(1)} 秒`;
  return `最近${r.source === 'probe' ? '检测' : '调用'} · ${r.ok ? '响应' : '失败'}耗时 ${duration}`;
}
function renderModels() {
  const signature = JSON.stringify([state.models, state.modelResults, state.probe, state.availableModels, state.activity, state.excludedModels, state.actionBusy, pendingAction, selected]);
  if (signature === lastModels) return; lastModels = signature;
  const scroll = $('models').scrollTop;
  const focused = document.activeElement?.dataset?.model;
  $('models').replaceChildren();
  const models = [...(state.models || [])].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  for (const model of models) {
    const row = element('div', 'model' + (selected === model.id ? ' selected' : '')); row.dataset.model = model.id;
    const choose = element('input', 'model-check'); choose.type = 'checkbox';
    choose.checked = !!state.availableModels?.includes(model.id) && !(state.excludedModels || []).includes(model.id);
    choose.disabled = !!(pendingAction || state.actionBusy || state.probe?.running || state.configSearch?.running || state.phase !== 'ready' || !state.availableModels?.includes(model.id));
    choose.setAttribute('aria-label', `导入 OC · ${model.name}`);
    choose.onclick = event => event.stopPropagation();
    choose.onchange = () => run('selection', { model: model.id, selected: choose.checked });
    const details = element('button', 'model-details');
    details.setAttribute('aria-label', `查看 OC · ${model.name} 详情`);
    details.setAttribute('aria-expanded', String(selected === model.id));
    const icon = element('span', 'model-icon'); icon.setAttribute('aria-hidden', 'true');
    icon.append(waiting(model.id) ? element('span', 'spinner') : element('span', '', '◇'));
    const info = element('div', 'model-info'); info.append(element('div', 'model-name', `OC · ${model.name}`), element('div', 'duration', timing(model.id)));
    const badges = element('div', 'badges');
    if (model.reasoning) badges.append(element('span', 'badge reasoning', '推理'));
    if (model.images) badges.append(element('span', 'badge images', '图片'));
    const status = label(model); badges.append(element('span', 'badge ' + (rank(model) === 2 ? 'unavailable' : rank(model) === 1 ? 'waiting' : ''), status));
    details.append(icon, info, badges); row.append(choose, details); details.onclick = () => { selected = selected === model.id ? null : model.id; renderModels(); renderDetails(); };
    $('models').append(row);
    if (focused === model.id) row.focus({ preventScroll: true });
  }
  if (!models.length) $('models').append(element('p', 'empty', '正在安装或扫描模型，完成后将在这里显示。'));
  $('models').scrollTop = scroll;
}
function renderDetails() {
  const model = state.models?.find(m => m.id === selected); $('details').hidden = !model;
  if (!model) return;
  const r = state.modelResults?.[model.id] || {};
  $('details').replaceChildren(element('strong', '', model.id));
  const add = (text, css = '') => $('details').append(element('p', css, text));
  if (r.chatOnly) add('已自动关闭工具调用；导入后仅支持普通对话。');
  if (Number.isInteger(r.nativeAttempts) && r.nativeAttempts > 0) add(`最近一次调用拦截了 ${r.nativeAttempts} 次本地执行尝试，动作必须由 WorkBuddy 执行。`, 'error-text');
  if (Number.isInteger(r.calls) && r.calls > 0) add(`最近一次调用返回了 ${r.calls} 个动作。`);
  if (r.handoff) add(`最近一次调用把被拦下的本地动作转交成外部 ${r.handoff} 调用。`);
  const repairs = Object.entries(r.repaired ?? {}).filter(([, value]) => value?.ok);
  if (repairs.length) add(`这一轮由格式兜底救回：${repairs.map(([shape, value]) => `${shape === 'action' ? '动作转写' : '信封重排'}（${String(value.model).replace('opencode/', '')}）`).join('、')}。`);
  add(`图片输入：${model.images ? '支持' : '不支持'}`);
  add(`上下文：${model.context ?? '未声明'} · 输入上限：${model.input ?? '未单独声明'} · 输出上限：${model.output ?? '未声明'}`);
  const variants = Object.keys(model.variants || {});
  add(model.reasoning ? `推理：支持 · ${variants.length ? '可选档位：' + variants.join(' / ') : '使用默认模式'}` : '推理：OpenCode 未声明支持');
  if (r.error) add(r.error, 'error-text');
  add('最近更新：' + (r.time ? new Date(r.time).toLocaleString() : '尚未检测'));
}
function render() {
  const busy = pendingAction || state.actionBusy || state.configSearch?.running || state.probe?.running || state.phase !== 'ready';
  for (const id of ['refresh', 'probe', 'import', 'proxy']) $(id).disabled = !!busy;
  $('restart').hidden = state.phase !== 'error';
  $('restart').disabled = !!(pendingAction || state.actionBusy);
  $('proxy').disabled = !!(pendingAction || state.actionBusy || state.configSearch?.running || state.probe?.running || !['ready', 'error'].includes(state.phase));
  $('proxy').checked = state.useSystemProxy === true;
  $('service-text').textContent = window.OWActivity.activityText(state.activity?.[0]) || state.message || '正在启动隔离模型服务';
  $('service-dot').className = 'dot' + (state.phase === 'error' ? ' error' : '');
  $('discovered').textContent = state.models?.length || 0;
  $('available').textContent = state.availableModels?.length || 0;
  $('pending').textContent = state.models?.filter(m => rank(m) === 1).length || 0;
  for (const [id, title, active] of [['refresh', '读取免费模型', state.actionBusy === 'refresh'], ['probe', '检测全部', state.probe?.running], ['import', '导入 WorkBuddy', state.actionBusy === 'import']]) {
    $(id).replaceChildren(); if (active) $(id).append(element('span', 'spinner'));
    $(id).append(document.createTextNode(active ? id === 'import' ? '正在导入…' : id === 'refresh' ? '正在读取…' : '正在检测…' : title));
  }
  const sync = state.sync;
  $('sync').textContent = (state.configSearch?.running ? 'OpenCode 正在只读查找 WorkBuddy 配置…' : state.configSearch?.candidates?.length > 1 && !state.modelsFile ? '已找到配置文件，点击导入 WorkBuddy 使用最近访问的一份。' : '') || sync?.error || (sync?.time ? `已导入 ${sync.count ?? 0} 个模型 · 再次检测后需点击导入 WorkBuddy 更新` : '首次读取和检测完成后自动导入 WorkBuddy');
  renderModels(); renderDetails();
}
async function run(name, value) {
  if (pendingAction) return; pendingAction = true; $('feedback').hidden = true; render();
  try {
    const response = await window.buddy.action(name, value);
    if (!response.ok) throw new Error(response.error);
    if (name === 'selection') { state.excludedModels = response.result.excludedModels; feedback('选择已保存，点击导入 WorkBuddy 后生效。'); }
    if (name === 'import') {
      const r = response.result;
      if (r.canceled) { feedback('已取消导入，配置未更改。'); return; }
      feedback(r.changed === false ? `配置已是最新，共 ${r.count} 个模型，无需重复写入。` : `导入完成，已将 ${r.count} 个可用模型导入 WorkBuddy。`);
    }
  } catch (error) { feedback(error.message, true); }
  finally { pendingAction = false; render(); }
}
function feedback(text, error = false) { $('feedback').textContent = text; $('feedback').className = error ? 'error' : ''; $('feedback').hidden = false; }
for (const action of ['refresh', 'probe', 'import', 'restart']) $(action).onclick = () => run(action);
$('proxy').onchange = () => run('system-proxy', $('proxy').checked);
function dismiss() { selected = null; renderModels(); renderDetails(); }
document.addEventListener('click', e => { if (!e.target.closest('.model') && !e.target.closest('#details')) dismiss(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') dismiss(); });
window.buddy.onDismiss(dismiss);
window.buddy.onState(next => { state = next; render(); });
render();
