import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const directEnvironment = () => ({ NO_PROXY: 'localhost,127.0.0.1,::1', no_proxy: 'localhost,127.0.0.1,::1' });

export function parseSystemProxy(text) {
  const value = name => text.match(new RegExp(`^\\s*${name}\\s*:\\s*(.*?)\\s*$`, 'm'))?.[1];
  function address(kind) {
    if (value(`${kind}Enable`) !== '1') return undefined;
    const host = value(`${kind}Proxy`), port = Number(value(`${kind}Port`));
    if (!host || /[\s/@?#]/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error('系统代理地址无效');
    return `http://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}`;
  }
  const http = address('HTTP'), https = address('HTTPS');
  if (!http && !https) return directEnvironment();
  return { HTTP_PROXY: http || https, HTTPS_PROXY: https || http,
    http_proxy: http || https, https_proxy: https || http,
    NO_PROXY: 'localhost,127.0.0.1,::1', no_proxy: 'localhost,127.0.0.1,::1' };
}
export async function systemProxyEnvironment(enabled) {
  if (!enabled) return directEnvironment();
  if (process.platform === 'win32') {
    const script = "Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' | Select-Object ProxyEnable,ProxyServer | ConvertTo-Json -Compress";
    const result = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 5000, windowsHide: true });
    return parseWindowsProxy(JSON.parse(result.stdout));
  }
  if (process.platform !== 'darwin') throw new Error('此系统暂不支持读取系统代理');
  return parseSystemProxy((await exec('/usr/sbin/scutil', ['--proxy'], { timeout: 5000 })).stdout);
}

export function parseWindowsProxy(settings) {
  if (!Number(settings.ProxyEnable) || !settings.ProxyServer) return directEnvironment();
  const entries = String(settings.ProxyServer).trim().split(';').filter(Boolean);
  const split = entries.some(x => x.includes('='));
  const map = split ? Object.fromEntries(entries.map(x => x.trim().split('='))) : { http: entries[0], https: entries[0] };
  if (!map.http && !map.https) return directEnvironment();
  const address = value => {
    if (!value || /[\s/@?#]/.test(value)) throw new Error('Windows 系统代理地址无效');
    let url;
    try { url = new URL('http://' + value); } catch { throw new Error('Windows 系统代理地址无效'); }
    const port = Number(value.match(/:(\d+)$/)?.[1]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Windows 系统代理端口无效');
    return url.origin;
  };
  const https = address(map.https || map.http), http = address(map.http || map.https);
  return { HTTP_PROXY: http, HTTPS_PROXY: https || http, http_proxy: http, https_proxy: https || http,
    NO_PROXY: 'localhost,127.0.0.1,::1', no_proxy: 'localhost,127.0.0.1,::1' };
}
