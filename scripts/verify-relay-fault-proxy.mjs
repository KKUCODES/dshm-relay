import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

// 本机故障注入工具：生产网关和协议均不改，只暂存/丢弃设备连接的原始响应字节。
// 不记录请求头、凭据或业务正文。关闭时释放本工具启动的网关子进程。
if (process.env.DSHM_FAULT_TEST !== '1') throw new Error('Explicit local fault-test flag required');
const gateway = spawn(process.execPath, ['--env-file=.env.local', 'packages/gateway/dist/main.js'], {
  cwd: process.cwd(), env: { ...process.env, HOST: '127.0.0.1', PORT: '8788' }, windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
const peers = new Set();
let paused = false, droppedBytes = 0, closing = false;
const relay = net.createServer(client => {
  const upstream = net.connect(8788, '127.0.0.1');
  const peer = { client, upstream, device: false, classified: false, prefix: '', held: [], bytes: 0 };
  peers.add(peer);
  const dispose = () => { peers.delete(peer); peer.held = []; client.destroy(); upstream.destroy(); };
  client.on('error', dispose); upstream.on('error', dispose);
  client.on('close', dispose); upstream.on('close', dispose);
  client.on('data', bytes => {
    if (!peer.classified) {
      peer.prefix += bytes.subarray(0, Math.max(0, 256 - peer.prefix.length)).toString('latin1');
      const end = peer.prefix.indexOf('\r\n');
      if (end >= 0 || peer.prefix.length >= 256) {
        peer.device = /^GET \/v1\/device\/socket HTTP\/1\.[01]\r\n/.test(peer.prefix);
        peer.prefix = ''; peer.classified = true;
      }
    }
    if (!upstream.write(bytes)) client.pause();
  });
  upstream.on('drain', () => client.resume());
  upstream.on('data', bytes => {
    if (paused && peer.device) {
      peer.held.push(bytes); peer.bytes += bytes.length; upstream.pause();
      if (peer.bytes > 512 * 1024) dispose();
    } else if (!client.write(bytes)) upstream.pause();
  });
  client.on('drain', () => { if (!paused || !peer.device) upstream.resume(); });
});
const stats = () => ({ paused, devices: [...peers].filter(peer => peer.device).length,
  heldBytes: [...peers].reduce((n, peer) => n + peer.bytes, 0), droppedBytes, gatewayPid: gateway.pid });
const control = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/pause') paused = true;
  else if (req.method === 'POST' && req.url === '/drop') {
    paused = false;
    for (const peer of peers) if (peer.device) {
      droppedBytes += peer.bytes; peer.bytes = 0; peer.held = [];
      peer.client.destroy(); peer.upstream.destroy();
    }
  } else if (req.method === 'POST' && req.url === '/resume') {
    paused = false;
    for (const peer of peers) {
      for (const bytes of peer.held) peer.client.write(bytes);
      peer.bytes = 0; peer.held = []; peer.upstream.resume();
    }
  } else if (req.method === 'POST' && req.url === '/stop') {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"stopping":true}');
    void close(); return;
  } else if (req.method !== 'GET' || req.url !== '/stats') { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(stats()));
});
async function close() {
  if (closing) return; closing = true;
  for (const peer of peers) { peer.client.destroy(); peer.upstream.destroy(); }
  relay.close(); control.close();
  if (gateway.exitCode === null) { gateway.kill(); await once(gateway, 'exit'); }
}
try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Gateway startup timeout')), 15000);
    gateway.once('error', reject); gateway.once('exit', () => reject(new Error('Gateway exited')));
    gateway.stdout.on('data', bytes => {
      if (bytes.toString().includes('Server listening at')) { clearTimeout(timeout); resolve(); }
    });
    // 排空日志但不输出，避免将运行配置带入测试报告。
    gateway.stderr.resume();
  });
  relay.listen(8787, '127.0.0.1'); await once(relay, 'listening');
  control.listen(18793, '127.0.0.1'); await once(control, 'listening');
  console.log(JSON.stringify({ state: 'ready', relay: 8787, control: 18793, gatewayPid: gateway.pid }));
  gateway.once('exit', () => void close());
} catch (error) { await close(); console.error(error.message); process.exitCode = 1; }
