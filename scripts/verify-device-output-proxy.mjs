import net from 'node:net';
import http from 'node:http';
import { once } from 'node:events';
import { HeldWebSocketFrames } from './held-websocket-frames.mjs';
import { MAX_FRAME_BYTES } from '../packages/protocol/dist/index.js';

// 不启动/修改网关；仅测试App经ADB反向端口连接本机9878，仍使用原8787鉴权地址。
if (process.env.DSHM_FAULT_TEST !== '1') throw Error('Explicit local fault-test flag required');
const peers = new Set();
let paused = false, selectedPaused = false, othersPaused = false, initialLoadingPaused = false, droppedBytes = 0, closedDevices = 0;
const isCordisEcho = frame => {
  if (frame[0] !== 0x81) return false;
  const size = frame[1] & 127, header = size === 126 ? 4 : size === 127 ? 10 : 2;
  try {
    const message = JSON.parse(frame.subarray(header).toString('utf8'));
    const rpc = message.type === 'result' && message.value?.ok === true ? message.value.value : null;
    return rpc?.ok === true && rpc.value?.echoed === 'DSHM_CORDIS_ECHO'
      && rpc.value.calls === 2 && rpc.value.failures === 0;
  } catch { return false; }
};
const relay = net.createServer(client => {
  const upstream = net.connect(8787, '127.0.0.1');
  const peer = { client, upstream, device: false, classified: false, prefix: '', response: Buffer.alloc(0), upgraded: false, rejectedApprovals: 0 };
  // 正常历史也经过该代理，帧上限须覆盖协议允许的数据和10字节WebSocket头。
  const gate = new HeldWebSocketFrames(bytes => {
    // 首次装配验收只放行真实 ready，随后暂缓协商结果；认证握手和数据字节不修改。
    if (bytes[0] === 0x81) {
      const size = bytes[1] & 127, header = size === 126 ? 4 : size === 127 ? 10 : 2;
      try {
        const frame = JSON.parse(bytes.subarray(header).toString('utf8'));
        if (frame.type === 'ready' && frame.protocol === 1) peer.readySeen = true;
      } catch { /* 只读取状态类型，不记录帧内容。 */ }
    }
    // 统计实际放行给固定测试端的结算拒绝，不依赖可能重新展开的审批弹层。
    if (peer.cordisSelected && bytes[0] === 0x81) {
      const size = bytes[1] & 127, header = size === 126 ? 4 : size === 127 ? 10 : 2;
      try {
        const message = JSON.parse(bytes.subarray(header).toString('utf8'));
        if (message.type === 'result' && message.value?.ok === true && message.value.value?.accepted === false) peer.rejectedApprovals++;
      } catch { /* 非JSON帧原样转发。 */ }
    }
    client.write(bytes);
  }, MAX_FRAME_BYTES + 10); peer.gate = gate; peers.add(peer);
  let disposed = false;
  const dispose = () => {
    if (disposed) return; disposed = true; gate.drop(); droppedBytes += gate.droppedBytes;
    if (peer.device) closedDevices++; peers.delete(peer); client.destroy(); upstream.destroy();
  };
  client.on('error', dispose); upstream.on('error', dispose); client.on('close', dispose);
  // 把真实close帧和FIN交给手机；不用destroy抢先丢弃已写出的撤销状态。
  upstream.on('end', () => client.end()); upstream.on('close', () => { if (!client.writableEnded) client.end(); });
  client.on('data', bytes => {
    if (!peer.classified) {
      peer.prefix += bytes.subarray(0, Math.max(0, 256 - peer.prefix.length)).toString('latin1');
      if (peer.prefix.includes('\r\n') || peer.prefix.length >= 256) {
        peer.device = /^GET \/v1\/device\/socket HTTP\/1\.[01]\r\n/.test(peer.prefix);
        peer.classified = true; peer.prefix = '';
      }
    }
    if (!upstream.write(bytes)) client.pause();
  });
  upstream.on('drain', () => client.resume());
  upstream.on('data', bytes => {
    try {
      if (!peer.device) { if (!client.write(bytes)) upstream.pause(); return; }
      if (!peer.upgraded) {
        peer.response = Buffer.concat([peer.response, bytes]);
        if (peer.response.length > 65536) throw Error('Test handshake limit exceeded');
        const end = peer.response.indexOf('\r\n\r\n'); if (end < 0) return;
        if (!peer.response.subarray(0, end).toString('latin1').startsWith('HTTP/1.1 101 ')) {
          peer.device = false; client.write(peer.response); peer.response = Buffer.alloc(0); return;
        }
        client.write(peer.response.subarray(0, end + 4)); bytes = peer.response.subarray(end + 4);
        peer.response = Buffer.alloc(0); peer.upgraded = true;
      }
      gate.push(bytes, paused || (initialLoadingPaused && peer.readySeen) || (selectedPaused && peer.cordisSelected) || (othersPaused && !peer.cordisSelected));
      if (client.writableLength > 512 * 1024) upstream.pause();
    } catch { dispose(); }
  });
  client.on('drain', () => upstream.resume());
});
const stats = () => ({ paused, selectedPaused, othersPaused, selectedDevices: [...peers].filter(peer => peer.cordisSelected).length,
  initialLoadingPaused,
  heldNegotiations: [...peers].reduce((sum, peer) => sum + peer.gate.held.filter(frame => {
    if (frame[0] !== 0x81) return false;
    const size = frame[1] & 127, header = size === 126 ? 4 : size === 127 ? 10 : 2;
    try {
      const message = JSON.parse(frame.subarray(header).toString('utf8'));
      return message.type === 'result' && message.value?.transport === 2 && typeof message.value?.dshVersion === 'string';
    } catch { return false; }
  }).length, 0),
  selectedRejectedApprovals: [...peers].filter(peer => peer.cordisSelected).reduce((sum, peer) => sum + peer.rejectedApprovals, 0),
  devices: [...peers].filter(peer => peer.device).length,
  // 只暴露形状计数，不记录请求身份、搜索词或摘要；用于证明确有搜索结果被暂缓。
  heldSearchResults: [...peers].reduce((sum, peer) => sum + peer.gate.held.filter(frame => {
    if (frame[0] !== 0x81) return false;
    const size = frame[1] & 127, header = size === 126 ? 4 : size === 127 ? 10 : 2;
    try {
      const message = JSON.parse(frame.subarray(header).toString('utf8'));
      const value = message.type === 'result' && message.value?.ok === true ? message.value.value : null;
      return typeof value?.hasMore === 'boolean' && Array.isArray(value.items)
        && value.items.every(item => typeof item.sessionId === 'string' && typeof item.snippet === 'string');
    } catch { return false; }
  }).length, 0),
  heldOutputResults: [...peers].reduce((sum, peer) => sum + peer.gate.held.filter(frame => {
    if (frame[0] !== 0x81) return false;
    const size = frame[1] & 127, header = size === 126 ? 4 : size === 127 ? 10 : 2;
    try {
      const message = JSON.parse(frame.subarray(header).toString('utf8'));
      // remote.jobOutput直接返回结果；不同于core.call中的原DSH ok/value信封。
      const value = message.type === 'result' ? message.value : null;
      return value?.state === 'available' && typeof value.data === 'string'
        && Number.isSafeInteger(value.startOffset) && Number.isSafeInteger(value.nextOffset)
        && Number.isSafeInteger(value.totalBytes) && typeof value.lossy === 'boolean';
    } catch { return false; }
  }).length, 0),
  // 只统计固定测试包的第二次回声：原Gateway和dynamicCordisRunner.invoke各有一层ok/value。
  heldCordisEchoResults: [...peers].reduce((sum, peer) => sum + peer.gate.held.filter(isCordisEcho).length, 0),
  heldStaleApprovalResults: [...peers].reduce((sum, peer) => sum + peer.gate.held.filter(frame => {
    if (frame[0] !== 0x81) return false;
    const size = frame[1] & 127, header = size === 126 ? 4 : size === 127 ? 10 : 2;
    try {
      const message = JSON.parse(frame.subarray(header).toString('utf8'));
      const value = message.type === 'result' && message.value?.ok === true ? message.value.value : null;
      return value?.accepted === false || (value?.ok === false && typeof value.message === 'string'
        && value.message.startsWith('run request "'));
    } catch { return false; }
  }).length, 0),
  heldResourceChunks: [...peers].reduce((sum, peer) => sum + peer.gate.held.filter(frame => {
    if (frame[0] !== 0x81) return false;
    const size = frame[1] & 127, header = size === 126 ? 4 : size === 127 ? 10 : 2;
    try {
      const message = JSON.parse(frame.subarray(header).toString('utf8'));
      return message.type === 'event' && message.value?.type === 'chunk' && typeof message.value.data === 'string';
    } catch { return false; }
  }).length, 0),
  heldBytes: [...peers].reduce((sum, peer) => sum + peer.gate.heldBytes, 0),
  droppedBytes: droppedBytes + [...peers].reduce((sum, peer) => sum + peer.gate.droppedBytes, 0), closedDevices });
const control = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/pause') paused = true;
  // 用已观察到的固定回声锁定测试App主连接，不读取设备凭据或延迟另一端的状态。
  else if (req.method === 'POST' && req.url === '/pin-cordis') {
    const candidates = [...peers].filter(peer => peer.gate.held.some(isCordisEcho));
    if (candidates.length !== 1) { res.writeHead(409).end(); return; }
    for (const peer of peers) peer.cordisSelected = peer === candidates[0];
  }
  else if (req.method === 'POST' && req.url === '/pause-cordis') {
    if ([...peers].filter(peer => peer.cordisSelected).length !== 1) { res.writeHead(409).end(); return; }
    selectedPaused = true;
  }
  // 先全端暂缓，再仅放行已锁定的测试端，另一端启动回执继续在途。
  else if (req.method === 'POST' && req.url === '/pause-others') {
    const selected = [...peers].filter(peer => peer.cordisSelected);
    if (selected.length !== 1) { res.writeHead(409).end(); return; }
    paused = false; selectedPaused = false; othersPaused = true; selected[0].gate.resume();
  }
  // 保留已暂缓的数据，让后续响应先通过，复现异步请求结果的先后颠倒。
  else if (req.method === 'POST' && req.url === '/pass') paused = false;
  else if (req.method === 'POST' && req.url === '/resume') { paused = false; selectedPaused = false; othersPaused = false; initialLoadingPaused = false; for (const peer of peers) peer.gate.resume(); }
  else if (req.method === 'POST' && req.url === '/pause-initial-load') initialLoadingPaused = true;
  else if (req.method === 'POST' && req.url === '/drop') {
    paused = false; initialLoadingPaused = false;
    for (const peer of peers) if (peer.device) { peer.client.destroy(); peer.upstream.destroy(); }
  }
  else if (req.method === 'POST' && req.url === '/stop') {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"stopping":true}');
    for (const peer of peers) { peer.client.destroy(); peer.upstream.destroy(); } relay.close(); control.close(); return;
  } else if (req.method !== 'GET' || req.url !== '/stats') { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(stats()));
});
relay.listen(9878, '127.0.0.1'); await once(relay, 'listening');
control.listen(18794, '127.0.0.1'); await once(control, 'listening');
console.log(JSON.stringify({ state: 'ready', relay: 9878, target: 8787, control: 18794 }));
