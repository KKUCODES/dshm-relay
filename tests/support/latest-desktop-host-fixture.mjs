import { readFile, writeFile, realpath, rename } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';

/** 仅在隔离测试中延迟原查询返回或原启动调用；正式插件和网关没有这些控制入口。 */
export async function apply(ctx) {
  const root = await realpath(resolve(import.meta.dirname, '../../../plugin/artifacts/latest-runtime-check/relay-homes'));
  const home = await realpath(process.env.DSH_HOME);
  const within = relative(root, home);
  if (!within || within.startsWith('..') || isAbsolute(within)) throw Error('fixture_outside_isolated_home');
  const input = resolve(home, 'desktop-control.json'), output = resolve(home, 'desktop-receipt.json');
  const workspace = resolve(home, 'test-project'), movedWorkspace = resolve(home, 'test-project-held');
  let closed = false, busy = false, seen, owner, hold, servicePresent = false, serviceGeneration = 0;
  let listCalls = 0, openCalls = 0, moved = false;
  const describe = () => ({ servicePresent, serviceGeneration, listCalls, openCalls, moved,
    hold: hold ? { entered: hold.entered, released: hold.released, settled: hold.settled,
      aborted: hold.signal?.aborted ?? false, serviceReleased: hold.serviceReleased,
      phase: hold.phase, nativeOpenSettled: hold.nativeOpenSettled } : null });
  ctx.inject(['dshmDesktopApps'], scope => {
    const apps = scope.dshmDesktopApps, list = apps.list, open = apps.open;
    servicePresent = true; serviceGeneration++;
    const heldList = async function (signal) {
      listCalls++;
      const value = await list.call(apps, signal);
      const active = hold;
      if (active?.phase === 'list' && !active.entered) {
        active.entered = true; active.signal = signal;
        await active.wait;
        active.settled = true;
      }
      return value;
    };
    const observedOpen = async function (...args) {
      openCalls++;
      const active = hold?.phase === 'open' && !hold.entered ? hold : undefined;
      if (active) {
        active.entered = true; active.signal = args[2];
        await active.wait;
        active.settled = true;
      }
      try { return await open.apply(apps, args); }
      finally { if (active) active.nativeOpenSettled = true; }
    };
    apps.list = heldList; apps.open = observedOpen;
    scope.effect(() => () => {
      servicePresent = false;
      if (hold?.entered && !hold.settled) hold.serviceReleased = true;
      if (apps.list === heldList) apps.list = list;
      if (apps.open === observedOpen) apps.open = open;
    });
  });
  const tick = async () => {
    if (closed || busy) return;
    busy = true;
    let id;
    try {
      const request = JSON.parse(await readFile(input, 'utf8'));
      id = request.id;
      if (seen === id) return;
      if (!/^[0-9a-f-]{36}$/.test(id) || !/^latest-relay-[0-9a-f-]{36}$/.test(request.sessionId)) throw Error('fixture_invalid_request');
      if (owner && owner !== request.sessionId) throw Error('fixture_owner_changed');
      owner = request.sessionId; seen = id;
      if (request.action === 'arm' || request.action === 'arm-open') {
        if (!servicePresent || hold && !hold.settled) throw Error('fixture_desktop_busy');
        hold = { entered: false, released: false, settled: false, serviceReleased: false,
          phase: request.action === 'arm-open' ? 'open' : 'list', nativeOpenSettled: false };
        hold.wait = new Promise(done => { hold.release = done; });
      } else if (request.action === 'release') {
        if (!hold?.entered || hold.released) throw Error('fixture_desktop_not_held');
        hold.released = true; hold.release();
      } else if (request.action === 'move') {
        if (moved || !hold?.entered || hold.released) throw Error('fixture_desktop_wrong_move');
        await rename(workspace, movedWorkspace); moved = true;
      } else if (request.action === 'restore') {
        if (!moved) throw Error('fixture_desktop_not_moved');
        await rename(movedWorkspace, workspace); moved = false;
      } else if (request.action !== 'status') throw Error('fixture_unknown_action');
      await writeFile(output, JSON.stringify({ id, observation: describe() }));
    } catch (error) {
      if (error.code !== 'ENOENT') await writeFile(output, JSON.stringify({ id, error: error.message }));
    } finally { busy = false; }
  };
  const timer = setInterval(() => { void tick(); }, 50);
  ctx.effect(() => () => {
    closed = true; clearInterval(timer);
    hold?.release();
  });
}
