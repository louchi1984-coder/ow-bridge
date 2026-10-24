import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSystemProxy, parseWindowsProxy, systemProxyEnvironment } from '../src/system-proxy.js';
test('system proxy maps HTTP and HTTPS and bypasses local services', () => {
  const env = parseSystemProxy('HTTPEnable : 1\nHTTPProxy : 127.0.0.1\nHTTPPort : 7892\nHTTPSEnable : 1\nHTTPSProxy : 127.0.0.1\nHTTPSPort : 7892');
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:7892');
  assert.equal(env.HTTP_PROXY, env.HTTPS_PROXY);
  assert.equal(env.https_proxy, env.HTTPS_PROXY);
  assert.equal(env.NO_PROXY, 'localhost,127.0.0.1,::1');
});
test('off does not inherit proxy; absent HTTP proxy is direct and malformed addresses fail', async () => {
  assert.equal((await systemProxyEnvironment(false)).HTTPS_PROXY, undefined);
  assert.equal(parseSystemProxy('SOCKSEnable : 1').HTTPS_PROXY, undefined);
  assert.throws(() => parseSystemProxy('HTTPSEnable : 1\nHTTPSProxy : 127.0.0.1\nHTTPSPort : 99999'), /无效/);
});

test('enabled system mode uses direct when manual HTTP/HTTPS proxy is absent on either OS', () => {
  for (const text of ['', 'HTTPEnable : 0\nHTTPSEnable : 0', 'ProxyAutoConfigEnable : 1']) {
    const env = parseSystemProxy(text);
    assert.equal(env.HTTPS_PROXY, undefined);
    assert.equal(env.NO_PROXY, 'localhost,127.0.0.1,::1');
  }
  for (const settings of [{}, {ProxyEnable:0,ProxyServer:'localhost:7890'}, {ProxyEnable:1}, {ProxyEnable:1,ProxyServer:'socks=localhost:1080'}]) {
    assert.equal(parseWindowsProxy(settings).HTTPS_PROXY, undefined);
  }
  assert.equal(parseSystemProxy('HTTPEnable : 1\nHTTPProxy : localhost\nHTTPPort : 7890').HTTPS_PROXY, 'http://localhost:7890');
  assert.equal(parseSystemProxy('HTTPSEnable : 1\nHTTPSProxy : localhost\nHTTPSPort : 7890').HTTP_PROXY, 'http://localhost:7890');
});
