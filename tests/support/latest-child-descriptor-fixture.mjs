import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';

export const inject = ['sessionController', 'sessions', 'sessionQuery', 'subagents'];

/** 故障只写独立 home 的原 Session；不替换投影、认证或 Remote 响应。 */
export async function apply(ctx) {
  const root = await realpath(resolve(import.meta.dirname, '../../../plugin/artifacts/latest-runtime-check/relay-homes'));
  const home = await realpath(process.env.DSH_HOME), within = relative(root, home);
  assert.ok(within && !within.startsWith('..') && !isAbsolute(within));
  assert.ok(within.startsWith('latest-child-descriptor-'));
  const input = resolve(home, 'child-control.json'), output = resolve(home, 'child-receipt.json');
  const lifetime = new AbortController();
  let seen, owner, children, busy = false, closed = false;
  const inspect = async id => {
    const observation = await ctx.sessionQuery.observeSession(id, { signal: lifetime.signal });
    try {
      return JSON.parse(JSON.stringify({ header: observation.header, events: observation.events,
        inheritedEventCount: observation.inheritedEventCount, projections: observation.projections }));
    } finally { observation[Symbol.dispose](); }
  };
  const tick = async () => {
    if (busy || closed) return;
    busy = true;
    let id;
    try {
      const request = JSON.parse(await readFile(input, 'utf8')); id = request.id;
      if (seen === id) return;
      assert.match(id, /^[0-9a-f-]{36}$/);
      assert.match(request.sessionId, /^latest-relay-[0-9a-f-]{36}$/);
      assert.ok(!owner || owner === request.sessionId); owner = request.sessionId; seen = id;
      if (request.action === 'seed') {
        assert.equal(children, undefined);
        const found = await ctx.sessionController.resolveAgent(owner); assert.equal(found.error, undefined);
        const run = await ctx.subagents.start('spawn', { parent: found.agent, label: 'Descriptor healthy sibling',
          prompt: [{ type: 'text', text: 'LATEST_CHILD_DESCRIPTOR_HEALTHY' }],
          signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(30000)]) });
        let original;
        try {
          assert.equal((await run.result).stopReason, 'error'); assert.ok(run.localAgent);
          original = await inspect(run.localAgent.id);
        } finally { await run.dispose(); }
        const descriptor = original.events.find(event => event.type === 'subagent/descriptor');
        assert.ok(descriptor); assert.equal(descriptor.data.mode, 'one-shot');
        children = [{ kind: 'healthy', id: original.header.id, label: 'Descriptor healthy sibling' }];
        for (const kind of ['missing', 'malformed', 'unsupported']) {
          const child = ctx.sessions.create('descriptor-' + randomUUID(), { meta: {
            cwd: original.header.cwd, parentSession: owner, origin: 'subagent', delegationDepth: original.header.delegationDepth,
          } });
          const label = 'Descriptor ' + kind;
          // 与原 archive-admission 测试相同的故障数据入口。缺失不追加事件；
          // 另外两项从真实 provider 的 descriptor 派生，只损坏指定字段。
          if (kind !== 'missing') child.append('subagent/descriptor', kind === 'malformed'
            ? { ...descriptor.data, mode: 'continuable', label: 7 }
            : { ...descriptor.data, version: descriptor.data.version + 1 });
          assert.equal(await ctx.sessions.flush(child), true);
          found.agent.session.append('subagent/catalog', { version: 1, childId: child.id,
            childCreatedAt: child.header.createdAt, mode: 'unknown', label });
          children.push({ kind, id: child.id, label });
        }
        assert.equal(await ctx.sessions.flush(found.agent.session), true);
      } else assert.equal(request.action, 'inspect');
      assert.ok(children);
      const observations = [];
      for (const child of children) observations.push({ ...child, original: await inspect(child.id) });
      await writeFile(output, JSON.stringify({ id, owner, children: observations, parent: await inspect(owner),
        inferenceVerified: false, faultSource: 'original Session.create/append/flush; deliberate isolated descriptor faults' }));
    } catch (error) {
      if (error.code !== 'ENOENT') await writeFile(output, JSON.stringify({ id, error: error.message }));
    } finally { busy = false; }
  };
  const timer = setInterval(() => { void tick(); }, 50);
  ctx.effect(() => () => { closed = true; lifetime.abort(); clearInterval(timer); });
}
