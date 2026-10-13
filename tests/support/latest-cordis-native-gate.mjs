import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { clientFrameSchema } from '../../packages/protocol/dist/index.js';

/** 只观察随后接入的测试设备连接；延迟真实代码响应，不改变鉴权或协议结果。 */
export function createLatestNativeGate(server, { singleConnection = false } = {}) {
  const connections = new Set(), held = [];
  const report = { pageErrors: [], consoleErrors: [], operations: [], results: [], held: [], resources: 0, resourceUi: [], pageConnections: 0 };
  let holding = false, holdingStreams = false, heldBytes = 0, closed = false, accepting = true;
  const attach = (socket, request) => {
    if (request.url !== '/v1/device/socket' || closed || !accepting) return;
    if (singleConnection) accepting = false;
    const operations = new Map(), resourceChunks = new Map(), original = socket.send;
    let pageConnection = false;
    const receive = raw => {
      let parsed;
      try { parsed = clientFrameSchema.safeParse(JSON.parse(raw.toString())); } catch { return; }
      if (!parsed.success || parsed.data.type !== 'request') return;
      const { id, operation } = parsed.data;
      operations.set(id, operation);
      report.operations.push({ id, method: operation.method, endpoint: operation.endpoint });
      if (operation.method === 'remote.resource') report.resources++;
      if (operation.endpoint === 'session/follow' && !pageConnection) {
        pageConnection = true; report.pageConnections++;
      }
    };
    const wrapper = function (...args) {
      const bytes = Buffer.from(args[0]);
      let frame;
      try { frame = JSON.parse(bytes.toString()); } catch { return original.apply(this, args); }
      const op = operations.get(frame.id);
      if (op?.method === 'remote.resource' && op.path?.includes('dsh-client-ui-cordis')) {
        if (frame.type === 'event' && frame.value?.type === 'chunk') {
          const previous = resourceChunks.get(frame.id) ?? [];
          const chunk = Buffer.from(frame.value.data, 'base64');
          assert.ok(previous.reduce((size, value) => size + value.length, 0) + chunk.length <= 64 * 1024 * 1024);
          previous.push(chunk); resourceChunks.set(frame.id, previous);
        } else if (frame.type === 'end') {
          const body = Buffer.concat(resourceChunks.get(frame.id) ?? []); resourceChunks.delete(frame.id);
          report.resourceUi.push({ bytes: body.length, sha256: createHash('sha256').update(body).digest('hex'),
            inventoryReadyGuard: body.includes('const refreshInventory = inventory.refresh') });
        }
      }
      if (op?.endpoint?.startsWith('dynamicCordisRunner/') && ['result', 'error'].includes(frame.type))
        report.results.push({ id: frame.id, endpoint: op.endpoint, frame });
      if ((holding && op?.endpoint === 'dynamicCordisRunner/getClientCode')
        || (holdingStreams && op?.method === 'remote.stream')) {
        assert.ok(held.length < 256 && heldBytes + bytes.length <= 8 * 1024 * 1024, 'bounded native delivery queue');
        // ws 按载荷类型选择文本/二进制；保留原类型，否则原生文本监听不会收到代码。
        held.push({ socket, original, args: [typeof args[0] === 'string' ? args[0] : bytes, ...args.slice(1)] });
        heldBytes += bytes.length;
        report.held.push({ type: frame.type, endpoint: op.endpoint, bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex') });
        return;
      }
      return original.apply(this, args);
    };
    socket.on('message', receive); socket.send = wrapper;
    connections.add({ socket, original, wrapper, receive, operations });
  };
  server.on('connection', attach);
  const release = () => {
    holding = false; holdingStreams = false;
    for (const item of held.splice(0)) item.original.apply(item.socket, item.args);
    heldBytes = 0;
  };
  return { report,
    hold({ code = false, streams = false }) { holding = code; holdingStreams = streams; },
    acceptNextConnection() {
      assert.ok(singleConnection && !closed, '仅独立单连接门允许显式接入下一条测试连接');
      accepting = true;
    },
    release,
    async disconnectPage() {
      const pages = [...connections].filter(item => item.socket.readyState === 1
        && [...item.operations.values()].some(op => op.endpoint === 'session/follow'));
      assert.equal(pages.length, 1, '只有一个已接入门的实际 Android 页面连接');
      const socket = pages[0].socket, ended = once(socket, 'close');
      socket.close(4001, 'test_network_disconnect'); await ended;
    },
    close() {
      if (closed) return;
      closed = true; server.off('connection', attach); release();
      for (const { socket, original, wrapper, receive } of connections) {
        socket.off('message', receive);
        if (socket.send === wrapper) socket.send = original;
      }
      connections.clear();
    },
  };
}
