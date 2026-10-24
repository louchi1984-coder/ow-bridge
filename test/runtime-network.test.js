import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// Stop at spawn, after real startBackend has built the child's environment.
const stub = `
import { promisify } from 'node:util';
export function execFile() {}
execFile[promisify.custom] = async () => ({ stdout: '1.18.33' });
export function spawn(binary, args, options) {
  console.log(JSON.stringify(options.env));
  throw new Error('CAPTURED');
}`;
const loader = `export async function resolve(id, context, next) {
  if (id === 'node:child_process' && context.parentURL?.endsWith('/src/runtime.js'))
    return { url: ${JSON.stringify('data:text/javascript,' + encodeURIComponent(stub))}, shortCircuit: true };
  return next(id, context);
}`;
for (const enabled of [false, true]) test(`runtime uses ${enabled ? 'explicit system proxy' : 'normal direct connection without inherited proxy or IPv6 tunnel'}`, () => {
  const script = `
    import fs from 'node:fs/promises'; import os from 'node:os'; import path from 'node:path';
    import { startBackend } from './src/runtime.js';
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ow-network-'));
    try { await startBackend('fake-opencode', dir, { write() {} }, ${JSON.stringify(enabled ? { HTTPS_PROXY: 'http://127.0.0.1:7890' } : {})}); }
    catch(e) { if(e.message !== 'CAPTURED') throw e; }
    finally { await fs.rm(dir, {recursive:true,force:true}); }
  `;
  const result = spawnSync(process.execPath, ['--loader', 'data:text/javascript,' + encodeURIComponent(loader), '--input-type=module', '-e', script], {
    encoding: 'utf8', env: { ...process.env, HTTPS_PROXY: 'http://inherited.invalid:99', HTTP_PROXY: 'http://inherited.invalid:99' }, timeout: 15000,
  });
  assert.equal(result.status, 0, result.stderr);
  const env = JSON.parse(result.stdout.trim());
  assert.equal(env.HTTPS_PROXY, enabled ? 'http://127.0.0.1:7890' : undefined);
  for (const name of ['HTTP_PROXY', 'http_proxy', 'https_proxy']) assert.equal(env[name], undefined);
});
