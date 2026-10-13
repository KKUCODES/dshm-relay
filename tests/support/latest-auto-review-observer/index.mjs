import assert from 'node:assert/strict';
import { readFile, writeFile, rename, realpath } from 'node:fs/promises';
import { resolve, relative } from 'node:path';

export const inject = ['llm', 'tools', 'sessions', 'permissionPresets', 'approval'];
export async function apply(ctx) {
  const root = resolve(import.meta.dirname, '../../../../plugin/artifacts/latest-runtime-check/live-homes');
  const home = resolve(process.env.DSH_HOME ?? ''); assert.match(relative(root, home), /^[0-9a-f-]{36}$/);
  assert.equal(await realpath(home), resolve(await realpath(root), relative(root, home)));
  const controlPath = resolve(home, 'latest-auto-review-control.json'), reportPath = resolve(home, 'latest-auto-review-host.json');
  const report = { reviews: [], calls: [], dispatches: [] }; let writing = Promise.resolve();
  const control = async () => readFile(controlPath, 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  const valid = config => /^DSHM_LATEST_AUTO_[a-f0-9]{32}$/.test(config?.marker ?? '') && /^session-[0-9a-f-]{36}$/.test(config?.sessionId ?? '');
  const save = config => {
    const current = ctx.sessions.get(config.sessionId);
    const value = JSON.stringify({ ...report, sessionId: config.sessionId, marker: config.marker,
      current: current ? ctx.permissionPresets.current(current) : null,
      autoSessions: ctx.sessions.list().filter(session => ctx.permissionPresets.current(session) === 'auto').length,
      approvalPolicy: current ? ctx.approval.overrideOf(current) : null });
    writing = writing.then(async () => { await writeFile(reportPath + '.tmp', value); await rename(reportPath + '.tmp', reportPath); });
  };
  // 原流逐块透传；只观察随机标记对应的审核，不保存请求正文、reasoning或凭据。
  ctx.on('llm/stream', (options, next) => (async function* () {
    const config = await control();
    if (!valid(config) || !options.system?.startsWith('REVIEW_POLICY')
      || !options.messages.some(message => message.content?.some(part => part.type === 'text' && part.text.includes(config.marker)))) {
      yield* next(); return;
    }
    const row = { started: true, provider: options.provider, model: options.model };
    if (config.phase !== undefined) {
      assert.ok(['native-allow', 'ptc-allow', 'native-deny-ask', 'native-deny-plan', 'native-deny-never'].includes(config.phase)); row.phase = config.phase;
    }
    // 读取原五段请求最后的动作类型，用于区分 native 与真正的 PTC 内层审核。
    const pendingSections = options.messages.flatMap(message => message.content ?? [])
      .filter(part => part.type === 'text').flatMap(part => part.text.split('\n\nPENDING_ACTION\n\n').slice(1));
    assert.equal(pendingSections.length, 1);
    const pending = JSON.parse(pendingSections[0]);
    assert.ok(['native', 'ptc-inner'].includes(pending.mode)); assert.equal(typeof pending.name, 'string');
    row.mode = pending.mode; row.toolName = pending.name; report.reviews.push(row);
    const aborted = () => { row.aborted = true; save(config); };
    options.signal?.addEventListener('abort', aborted, { once: true }); if (options.signal?.aborted) aborted(); save(config);
    try {
      for await (const chunk of next()) {
        if (chunk.type === 'block-end' && chunk.block.type === 'text') {
          try { const decision = JSON.parse(chunk.block.text); row.risk = decision.risk; row.decision = decision.decision; }
          catch { row.invalidDecision = true; }
        }
        if (chunk.type === 'finish') { row.finish = chunk.reason.kind; row.failureCode = chunk.reason.failure?.code; }
        yield chunk;
      }
    } finally { options.signal?.removeEventListener('abort', aborted); row.ended = true; save(config); }
  })());
  // 原Auto gate置前；此处可达表示审核已进入下游，不改决定或工具体。
  ctx.on('tools/pre-execute', async (exec, next) => {
    const config = await control();
    if (valid(config) && exec.agent?.session.header.id === config.sessionId && JSON.stringify(exec.arguments).includes(config.marker)) {
      report.calls.push({ name: exec.name, callId: exec.callId,
        mode: exec.parent === undefined ? 'native' : 'ptc-inner',
        ...(config.phase === undefined ? {} : { phase: config.phase }) }); save(config);
    }
    return next();
  });
  // pre-execute 可在拒绝后转人工前继续检查；只有 execute 才说明进入真实调度。
  ctx.on('tools/execute', async (exec, next) => {
    const config = await control();
    if (valid(config) && exec.agent?.session.header.id === config.sessionId && JSON.stringify(exec.arguments).includes(config.marker)) {
      report.dispatches.push({ name: exec.name, callId: exec.callId }); save(config);
    }
    return next();
  });
  // 权限恢复没有模型流；只读轮询用于核对卸载前已无 Auto 会话。
  ctx.effect(() => {
    let busy = false;
    const timer = setInterval(async () => {
      if (busy) return; busy = true;
      try { const config = await control(); if (valid(config)) { save(config); await writing; } }
      finally { busy = false; }
    }, 250);
    return async () => { clearInterval(timer); await writing; };
  });
}
