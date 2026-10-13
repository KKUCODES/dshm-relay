import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { chromium } from '../../../dsh-mobile/node_modules/playwright/index.mjs';

/** DSHM 实际构建页面；仅在载体接收处延迟原字节，不伪造协议或 Host 结果。 */
export async function createLatestRacePage({ socket, ready, binding }) {
  const dist = resolve(import.meta.dirname, '../../../dsh-mobile/artifacts/latest-mobile-dist');
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 375, height: 667 } });
  page.setDefaultTimeout(15000);
  const report = { pageErrors: [], consoleErrors: [], operations: [], results: [], held: [], resources: 0 };
  const operations = new Map(), resources = new Map(), held = [];
  let holdStreams = false, holdCode = false, active = true, heldBytes = 0;
  const deliver = frame => page.evaluate(frame => window.DSHMRemote?.onmessage?.({ data: JSON.stringify({ event: frame }) }), frame);
  const receive = raw => {
    const bytes = Buffer.from(raw), frame = JSON.parse(bytes.toString()), resource = resources.get(frame.id);
    if (resource) {
      if (frame.type === 'event' && frame.value.type === 'headers') resource.headers = frame.value;
      else if (frame.type === 'event' && frame.value.type === 'chunk') {
        resource.chunks.push(Buffer.from(frame.value.data, 'base64'));
        socket.send(JSON.stringify({ type: 'ack', id: frame.id, count: 1 }));
      } else if (frame.type === 'end') resource.resolve({ ...resource.headers, body: Buffer.concat(resource.chunks) });
      else if (frame.type === 'error') resource.reject(Error(frame.code));
      return;
    }
    const op = operations.get(frame.id);
    if (op?.endpoint?.startsWith('dynamicCordisRunner/') && (frame.type === 'result' || frame.type === 'error'))
      report.results.push({ id: frame.id, endpoint: op.endpoint, frame });
    if ((holdStreams && op?.method === 'remote.stream') || (holdCode && op?.endpoint === 'dynamicCordisRunner/getClientCode')) {
      assert.ok(held.length < 256, 'bounded race delivery queue');
      assert.ok(heldBytes + bytes.length <= 8 * 1024 * 1024, 'bounded race delivery bytes');
      held.push(bytes);
      heldBytes += bytes.length;
      report.held.push({ type: frame.type, endpoint: op.endpoint, bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex') });
    } else if (active) void deliver(frame).catch(error => { if (active) report.pageErrors.push(error.message); });
  };
  socket.on('message', receive);
  const readResource = path => new Promise((accept, decline) => {
    const id = randomUUID();
    const timer = setTimeout(() => {
      resources.delete(id); socket.send(JSON.stringify({ type: 'cancel', id })); decline(Error('race_resource_timeout'));
    }, 30000);
    const finish = action => value => { clearTimeout(timer); resources.delete(id); action(value); };
    resources.set(id, { chunks: [], resolve: finish(accept), reject: finish(decline) });
    socket.send(JSON.stringify({ type: 'request', id, operation: { method: 'remote.resource', path, verb: 'GET' } }));
  });
  try {
    await page.exposeFunction('__dshmBridge', async ({ op, data }) => {
      if (op === 'appearance.read') return { data: { preference: 'light', fontSize: 14, enabled: true, language: 'zh' } };
      if (op === 'binding.info') return { data: binding };
      if (op === 'binding.status') return { data: { status: 'active' } };
      if (op === 'socket.connect') return { data: {}, event: ready };
      if (op === 'socket.send') {
        if (data.frame.operation) {
          operations.set(data.frame.id, data.frame.operation);
          report.operations.push({ id: data.frame.id, method: data.frame.operation.method, endpoint: data.frame.operation.endpoint });
        }
        socket.send(JSON.stringify(data.frame)); return { data: {} };
      }
      if (op === 'notifications.status') return { data: { status: 'disabled' } };
      if (['binding.link', 'notifications.take', 'notifications.context', 'socket.release'].includes(op)) return { data: {} };
      throw Error('race_bridge_operation_unavailable:' + op);
    });
    await page.addInitScript(() => {
      window.DSHMRemote = { postMessage(text) {
        const request = JSON.parse(text);
        window.__dshmBridge(request).then(value => {
          this.onmessage?.({ data: JSON.stringify({ id: request.id, data: value.data }) });
          if (value.event) this.onmessage?.({ data: JSON.stringify({ event: value.event }) });
        }, error => this.onmessage?.({ data: JSON.stringify({ id: request.id, error: error.message }) }));
      } };
    });
    await page.route('https://remote.dshm.invalid/**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith('/plugins/')) {
        const value = await readResource(url.pathname + url.search); report.resources++;
        return route.fulfill({ status: value.status, headers: value.headers, body: value.body });
      }
      const file = resolve(dist, '.' + decodeURIComponent(url.pathname));
      if (!file.startsWith(dist + sep)) return route.abort();
      const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
      try { await route.fulfill({ body: await readFile(file), contentType: mime[extname(file)] ?? 'application/octet-stream' }); }
      catch { await route.fulfill({ status: 404 }); }
    });
    page.on('pageerror', error => report.pageErrors.push(error.message));
    page.on('console', entry => { if (entry.type() === 'error') report.consoleErrors.push(entry.text()); });
    await page.goto('https://remote.dshm.invalid/remote.html');
    await page.getByTestId('remote-workspace').waitFor();
  } catch (error) { socket.off('message', receive); await browser.close(); throw error; }
  return { page, report,
    hold({ streams = false, code = false }) { holdStreams = streams; holdCode = code; },
    async release() {
      holdStreams = false; holdCode = false;
      // 重放捕获的原始接收字节，顺序保持；不从当前状态重新构造事件。
      for (const bytes of held.splice(0)) await deliver(JSON.parse(bytes.toString()));
      heldBytes = 0;
    },
    async close() {
      if (!active) return;
      active = false; socket.off('message', receive);
      for (const [id, resource] of resources) {
        if (socket.readyState === 1) socket.send(JSON.stringify({ type: 'cancel', id }));
        resource.reject(Error('race_page_closed'));
      }
      resources.clear(); held.length = 0; heldBytes = 0; await browser.close();
    },
  };
}
