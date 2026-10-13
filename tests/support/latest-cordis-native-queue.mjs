import assert from 'node:assert/strict';

/** 暂缓原生桥已经收到的真实代码响应；只用于独立 Android 测试 UID。 */
export async function createLatestNativeCodeQueue(page) {
  await page.evaluate(() => {
    if (window.__latestNativeCodeQueue) throw Error('native_code_queue_exists');
    const bridge = window.DSHMRemote, receive = bridge?.onmessage, send = bridge?.postMessage;
    if (typeof receive !== 'function' || typeof send !== 'function') throw Error('native_bridge_missing');
    const requests = [], held = [], codeIds = new Set();
    let holding = true, heldBytes = 0;
    const outbound = function (text) {
      const request = JSON.parse(text), frame = request.data?.frame, operation = frame?.operation;
      if (request.op === 'socket.send' && operation?.endpoint?.startsWith('dynamicCordisRunner/')) {
        requests.push({ id: frame.id, endpoint: operation.endpoint });
        if (operation.endpoint === 'dynamicCordisRunner/getClientCode') codeIds.add(frame.id);
      }
      return send.call(bridge, text);
    };
    const inbound = function (event) {
      const value = JSON.parse(event.data), frame = value.event;
      if (holding && frame && codeIds.has(frame.id) && ['result', 'error'].includes(frame.type)) {
        const bytes = new TextEncoder().encode(event.data).length;
        if (held.length >= 256 || heldBytes + bytes > 8 * 1024 * 1024) throw Error('native_code_queue_limit');
        held.push({ id: frame.id, data: event.data }); heldBytes += bytes;
        return;
      }
      return receive.call(bridge, event);
    };
    bridge.postMessage = outbound; bridge.onmessage = inbound;
    if (bridge.postMessage !== outbound || bridge.onmessage !== inbound) throw Error('native_queue_not_installed');
    const metadata = async () => Promise.all(held.map(async frame => {
      const bytes = new TextEncoder().encode(frame.data);
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
      return { id: frame.id, bytes: bytes.length, sha256: [...digest].map(value => value.toString(16).padStart(2, '0')).join('') };
    }));
    window.__latestNativeCodeQueue = {
      held, requests, metadata,
      freeze() { holding = false; },
      release() {
        holding = false;
        // 只投递捕获的原 event.data；不为新连接重新造结果或修改请求编号。
        for (const frame of held.splice(0)) receive.call(bridge, { data: frame.data });
        heldBytes = 0;
      },
      close() {
        holding = false; held.length = 0; heldBytes = 0;
        if (bridge.postMessage === outbound) bridge.postMessage = send;
        if (bridge.onmessage === inbound) bridge.onmessage = receive;
        delete window.__latestNativeCodeQueue;
      },
    };
  });
  let closed = false;
  return {
    async snapshot() {
      return page.evaluate(async () => {
        const queue = window.__latestNativeCodeQueue;
        return { held: await queue.metadata(), requests: [...queue.requests] };
      });
    },
    async freeze() { await page.evaluate(() => window.__latestNativeCodeQueue.freeze()); },
    async release() {
      const before = await this.snapshot(); assert.ok(before.held.length > 0);
      await page.evaluate(() => window.__latestNativeCodeQueue.release());
      return before.held;
    },
    async close() {
      if (closed) return; closed = true;
      if (!page.isClosed()) await page.evaluate(() => window.__latestNativeCodeQueue?.close());
    },
  };
}
