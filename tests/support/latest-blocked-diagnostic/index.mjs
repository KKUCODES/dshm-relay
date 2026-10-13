// 只拒绝独立 home 中控制文件指定的原会话和精确输入；turn/end 仍由原 DSH 生成。
import assert from 'node:assert/strict';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';

export function apply(ctx) {
  assert.ok(process.env.DSH_HOME);
  const root = resolve(import.meta.dirname, '../../../../plugin/artifacts/latest-runtime-check/live-homes');
  const home = resolve(process.env.DSH_HOME);
  assert.match(relative(root, home), /^[0-9a-f-]{36}$/);
  const control = resolve(home, 'latest-blocked-control.json');
  const report = resolve(home, 'latest-blocked-host.json');
  ctx.on('agent/pre-step', async (payload, next) => {
    const config = await readFile(control, 'utf8').then(JSON.parse).catch(() => null);
    if (!/^DSHM_LATEST_BLOCK_[a-f0-9]{32}$/.test(config?.marker ?? '')
      || config.sessionId !== payload.agent.session.header.id
      || !payload.messages.some(message => message.content?.some(part => part.type === 'text' && part.text === config.marker))) return next();
    assert.equal(await realpath(home), resolve(await realpath(root), relative(root, home)));
    const summary = { marker: config.marker, sessionId: config.sessionId, entered: true };
    await writeFile(report, JSON.stringify(summary));
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      payload.signal.throwIfAborted();
      const current = await readFile(control, 'utf8').then(JSON.parse).catch(() => null);
      if (current?.marker === config.marker && current.sessionId === config.sessionId && current.release === true) {
        await writeFile(report, JSON.stringify({ ...summary, rejected: true }));
        return { kind: 'reject' };
      }
      await new Promise(done => setTimeout(done, 100));
    }
    await writeFile(report, JSON.stringify({ ...summary, timedOut: true }));
    return { kind: 'reject' };
  });
}
