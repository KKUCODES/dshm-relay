// 只观察固定测试Host的事件身份和能力，不读取输出内容、不替代执行器或事件。
import assert from 'node:assert/strict';
import { writeFile, realpath } from 'node:fs/promises';
import { resolve, relative } from 'node:path';

export const name = 'latest-output-diagnostic';
export async function apply(ctx) {
  const base = resolve(import.meta.dirname, '../../../../plugin/artifacts/latest-runtime-check/live-homes');
  const home = await realpath(process.env.DSH_HOME);
  assert.match(relative(await realpath(base), home), /^[0-9a-f-]{36}$/);
  const file = resolve(home, 'output-diagnostic.json');
  const events = [], roots = new Map(); let writes = Promise.resolve();
  const record = event => {
    events.push({ at: Date.now(), ...event });
    writes = writes.then(() => writeFile(file, JSON.stringify({ events }, null, 2)));
    void writes.catch(() => {});
  };
  ctx.inject(['agents', 'tools', 'shell'], scope => {
    record({ type: 'ready', foregroundVersion: scope.shell.foregroundOutputVersion });
    scope.on('session/event', (session, event) => {
      if (event.type !== 'tool/call' || event.data.name !== 'pwsh') return;
      roots.set(JSON.stringify([session.id, event.data.callId]), session);
      record({ type: 'root', sessionId: session.id, callId: event.data.callId, time: event.time });
    });
    const identity = exec => ({ sessionId: exec.agent?.id, rootCallId: exec.rootCallId, callId: exec.callId,
      sameOwner: !!exec.agent && scope.agents.get(exec.agent.id) === exec.agent,
      sameSession: !!exec.agent && roots.get(JSON.stringify([exec.agent.id, exec.rootCallId])) === exec.agent.session });
    // 只核对原观察器的依赖和上下文身份，不替换任何监听器。
    const observers = exec => scope.events._hooks['tools/execute']
      .filter(hook => hook.callback.toString().includes('this.begin(exec)'))
      .map(hook => {
        try {
          const owner = hook.ctx.agents.get(exec.agent.id);
          return { foregroundGet: hook.ctx.get('shell')?.foregroundOutputVersion,
            foregroundInjected: hook.ctx.shell?.foregroundOutputVersion,
            sameOwner: owner === exec.agent,
            sameSession: roots.get(JSON.stringify([exec.agent.id, exec.rootCallId])) === owner?.session };
        } catch (error) { return { error: error.name }; }
      });
    scope.on('tools/execute', (exec, next) => {
      if (exec.name === 'pwsh') record({ type: 'execute', ...identity(exec), observers: observers(exec) });
      return next();
    });
    scope.on('tools/shell-output', (exec, output) => {
      if (exec.name === 'pwsh') record({ type: 'shell-output', ...identity(exec),
        stdoutBytes: typeof output.stdout.readBytesFrom === 'function', stderrBytes: typeof output.stderr.readBytesFrom === 'function' });
    });
    scope.on('tools/result', (exec, result) => {
      if (exec.name === 'pwsh') record({ type: 'result', ...identity(exec), isError: result.isError });
    });
  });
}
