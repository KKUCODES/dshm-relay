import assert from 'node:assert/strict';
import { readFile, writeFile, realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';

export const inject = ['sessionController', 'sessions', 'sessionQuery', 'agents'];

/** 只延迟独立 home 中原子会话的读取/提交；卸载与结算仍由原服务完成。 */
export async function apply(ctx) {
  const root = await realpath(resolve(import.meta.dirname, '../../../plugin/artifacts/latest-runtime-check/relay-homes'));
  const home = await realpath(process.env.DSH_HOME), within = relative(root, home);
  assert.ok(within && !within.startsWith('..') && !isAbsolute(within));
  assert.ok(within.startsWith('latest-child-unload-'));
  const input = resolve(home, 'child-control.json'), output = resolve(home, 'child-receipt.json');
  const lifetime = new AbortController();
  let owner, child, seen, hold, currentService, servicePresent = false, serviceGeneration = 0, closed = false, busy = false;
  let followCalls = 0, promptCalls = 0;
  const describe = () => ({ servicePresent, serviceGeneration, followCalls, promptCalls,
    hold: hold ? { phase: hold.phase, entered: hold.entered, released: hold.released,
      settled: hold.settled, serviceReleased: hold.serviceReleased, aborted: hold.signal?.aborted ?? false,
      result: hold.result } : null });
  const inspect = async id => {
    const observation = await ctx.sessionQuery.observeSession(id, { signal: lifetime.signal });
    try {
      return JSON.parse(JSON.stringify({ header: observation.header, events: observation.events,
        inheritedEventCount: observation.inheritedEventCount, projections: observation.projections }));
    } finally { observation[Symbol.dispose](); }
  };
  const target = address => address?.kind === 'subagent'
    && address.parentSessionId === owner && address.childSessionId === child;
  const wait = async (active, signal) => {
    active.entered = true; active.signal = signal;
    await active.wait;
  };
  const controller = ctx.sessionController, follow = controller.follow;
  const heldFollow = async function* (request, signal) {
    if (target(request.address)) followCalls++;
    const active = target(request.address) && hold?.phase === 'read' && !hold.entered ? hold : undefined;
    if (active) await wait(active, signal);
    try { yield* follow.call(controller, request, signal); }
    finally { if (active) active.settled = true; }
  };
  controller.follow = heldFollow;
  ctx.inject(['subagents'], scope => {
    const service = scope.subagents, prompt = service.prompt;
    currentService = service; servicePresent = true; serviceGeneration++;
    const heldPrompt = async function (request, signal) {
      const addressed = request.parentSessionId === owner && request.childSessionId === child;
      if (addressed) promptCalls++;
      const active = addressed && hold?.phase === 'submit' && !hold.entered ? hold : undefined;
      if (active) await wait(active, signal);
      try {
        const result = await prompt.call(service, request, signal);
        if (active) active.result = result.ok ? { accepted: true } : { accepted: false, code: result.error.code };
        return result;
      } catch (error) {
        if (active) active.result = { thrown: true, code: error.code, message: error.message };
        throw error;
      } finally { if (active) active.settled = true; }
    };
    service.prompt = heldPrompt;
    scope.effect(() => () => {
      servicePresent = false;
      if (currentService === service) currentService = undefined;
      if (hold?.entered && !hold.settled) hold.serviceReleased = true;
      if (service.prompt === heldPrompt) service.prompt = prompt;
    });
  });
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
        assert.equal(child, undefined); assert.equal(servicePresent, true);
        const found = await ctx.sessionController.resolveAgent(owner); assert.equal(found.error, undefined);
        const started = await currentService.startContinuable({ provider: 'spawn', label: 'Unload continuable child',
          request: { parent: found.agent, prompt: [{ type: 'text', text: 'LATEST_CHILD_UNLOAD_HISTORY' }] },
          signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(30000)]) });
        child = started.childId;
        const until = Date.now() + 30000;
        while (ctx.agents.get(child) !== undefined && Date.now() < until) await new Promise(done => setTimeout(done, 50));
        assert.equal(ctx.agents.get(child), undefined, 'original missing-credential child must settle');
        const original = await inspect(child);
        assert.equal(original.projections.values.subagent.mode, 'continuable');
        assert.ok(original.events.some(event => event.type === 'turn/end' && event.data.reason.kind === 'error'));
        // 子任务结算会向父会话投递原通知，并启动父轮次；基线必须等这轮真实处理完成。
        let parent;
        const parentUntil = Date.now() + 30000;
        do {
          parent = await inspect(owner);
          const notice = parent.events.find(event => event.type === 'user/message'
            && event.data.source?.kind === 'subagent-settled' && event.data.source.senderSessionId === child);
          if (notice && parent.events.some(event => event.seq > notice.seq && event.type === 'turn/end')) break;
          await new Promise(done => setTimeout(done, 50));
        } while (Date.now() < parentUntil);
        const notice = parent.events.find(event => event.type === 'user/message'
          && event.data.source?.kind === 'subagent-settled' && event.data.source.senderSessionId === child);
        assert.ok(notice && parent.events.some(event => event.seq > notice.seq && event.type === 'turn/end'), 'original parent settlement notice must finish');
        await writeFile(output, JSON.stringify({ id, child, label: 'Unload continuable child',
          original, parent, observation: describe(), inferenceVerified: false }));
        return;
      }
      if (request.action === 'status') {
        await writeFile(output, JSON.stringify({ id, child, observation: describe() }));
        return;
      }
      assert.ok(child);
      if (request.action === 'arm-read' || request.action === 'arm-submit') {
        assert.equal(servicePresent, true); assert.ok(!hold || hold.settled);
        hold = { phase: request.action === 'arm-read' ? 'read' : 'submit', entered: false,
          released: false, settled: false, serviceReleased: false };
        hold.wait = new Promise(done => { hold.release = done; });
      } else if (request.action === 'release') {
        assert.ok(hold?.entered && !hold.released); hold.released = true; hold.release();
      } else if (request.action === 'inspect') {
        await writeFile(output, JSON.stringify({ id, child, original: await inspect(child), parent: await inspect(owner), observation: describe() }));
        return;
      } else assert.equal(request.action, 'status');
      await writeFile(output, JSON.stringify({ id, child, observation: describe() }));
    } catch (error) {
      if (error.code !== 'ENOENT') await writeFile(output, JSON.stringify({ id, error: error.message }));
    } finally { busy = false; }
  };
  const timer = setInterval(() => { void tick(); }, 50);
  ctx.effect(() => () => {
    closed = true; lifetime.abort(); clearInterval(timer); hold?.release();
    if (controller.follow === heldFollow) controller.follow = follow;
  });
}
