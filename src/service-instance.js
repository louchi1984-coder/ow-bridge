import http from 'node:http';

// Reserve the actual service endpoint before touching shared files. The OS releases
// it even after a crash; a stale PID file cannot identify a different process as us.
export async function listenService(port) {
  const server = http.createServer((_req, res) => {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'OW Bridge 正在启动，请稍后重试' } }));
  });
  await new Promise((resolve, reject) => {
    const failed = error => {
      if (error.code === 'EADDRINUSE') error.message = `端口 ${port} 已被占用，OW Bridge 可能已在运行；请检查占用程序后重试。`;
      reject(error);
    };
    server.once('error', failed);
    server.listen(port, '127.0.0.1', () => { server.off('error', failed); resolve(); });
  });
  return server;
}
