import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
export async function findRuntime(dataDir, _, options = {}) {
  const catalog = JSON.parse(await fs.readFile(path.join(dataDir, 'catalog.json'), 'utf8'));
  if (options.update && catalog.updateError) throw new Error('update download failed');
  return options.update ? catalog.upgrade || 'test' : 'test';
}
export async function startBackend(binary, dataDir) {
  if (binary === 'broken') throw new Error('new runtime startup failed');
  const child = new EventEmitter();
  const read = async () => JSON.parse(await fs.readFile(path.join(dataDir, 'catalog.json'), 'utf8'));
  return { version: binary, child, stop: async () => child.emit('exit'), backend: {
    request: async () => [{ name: 'buddy-bridge' }],
    models: async () => (await read()).models,
    async complete(request) {
      await fs.appendFile(path.join(dataDir, 'requests.jsonl'), JSON.stringify({ model: request.model.id, chatOnly: request.chatOnly === true, time: Date.now() }) + '\n');
      if (request.tools.length && (await read()).probeTimeout) throw Object.assign(new Error('Model probe timed out'), { status: 504, code: 'timeout' });
      const failures = (await read()).gatewayErrors || {};
      const failure = failures[request.model.id];
      if (failure && (!failure.chatOnly || request.chatOnly)) throw Object.assign(new Error('Gateway rejected'), { status: failure.status, code: 'model_error' });
      await new Promise(resolve => setTimeout(resolve, 250));
      if ((await read()).checkTranslator) return { model: request.model.id, choices: [{ message: { role: 'assistant', content: typeof this.translator === 'function' ? (this.translator(request.model.id) ?? 'none') : 'missing' } }] };
      if ((await read()).chatOnly?.includes(request.model.id) && !request.chatOnly) throw Object.assign(new Error('only auto is supported for tool_choice'), { code: 'model_error' });
      if ((await read()).failed.includes(request.model.id)) throw new Error('insufficient_quota');
      if (!request.tools.length && (await read()).formatError) throw Object.assign(new Error('Invalid model response envelope'), { code: 'invalid_model_output' });
      if (request.tools.length) {
        const token = (JSON.parse(request.text)[0].content.match(/probe-([0-9a-f]+)\.txt/) || [])[1] || 'unknown';
        return { model: request.model.id, choices: [{ message: { content: null, tool_calls: [{ id: 'call_probe', type: 'function', function: { name: 'Read', arguments: JSON.stringify({ file_path: `/external/probe-${token}.txt` }) } }] } }] };
      }
      return { model: request.model.id, choices: [{ message: { role: 'assistant', content: 'OK' } }] };
    },
  } };
}
