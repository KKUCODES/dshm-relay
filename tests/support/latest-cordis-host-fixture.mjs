import { readFile, writeFile, realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';

export const inject = ['dynamicCordisRunner', 'sessionController', 'subagents'];

/** 仅隔离 CLI 载入的真实 Host 夹具；文件控制不进入 Remote 或正式包。 */
export async function apply(ctx) {
  const root = await realpath(resolve(import.meta.dirname, '../../../plugin/artifacts/latest-runtime-check/relay-homes'));
  const home = await realpath(process.env.DSH_HOME);
  const within = relative(root, home);
  if (!within || within.startsWith('..') || isAbsolute(within)) throw Error('fixture_outside_isolated_home');
  const input = resolve(home, 'cordis-control.json'), output = resolve(home, 'cordis-receipt.json');
  let seen, closed = false, busy = false, receipt, owner;
  const lifetime = new AbortController();
  const tick = async () => {
    if (closed || busy) return;
    busy = true;
    let id;
    try {
      const request = JSON.parse(await readFile(input, 'utf8'));
      id = request.id;
      if (seen === id) return;
      if (!/^[0-9a-f-]{36}$/.test(id) || !/^latest-relay-[0-9a-f-]{36}$/.test(request.sessionId)) throw Error('fixture_invalid_request');
      seen = id;
      if (owner && owner !== request.sessionId) throw Error('fixture_owner_changed');
      owner = request.sessionId;
      if (request.action === 'sidebar') {
        const found = await ctx.sessionController.resolveAgent(owner);
        if (found.error) throw found.error;
        // Original provider establishes its own durable descriptor/catalog and history.
        // The isolated profile has no real model credential; a failed child is still readable history.
        const run = await ctx.subagents.start('spawn', { parent: found.agent, label: 'Latest sidebar child',
          prompt: [{ type: 'text', text: 'LATEST_SIDEBAR_CHILD_HISTORY' }],
          signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(30000)]) });
        let sidebar;
        try {
          const result = await run.result;
          if (result.stopReason !== 'error' || !run.localAgent) throw Error('fixture_sidebar_unexpected_execution');
          sidebar = { id: run.id, workspacePath: run.localAgent.session.header.cwd, label: 'Latest sidebar child',
            source: 'original spawn provider; isolated missing-credential run, not model inference' };
        } finally { await run.dispose(); }
        await writeFile(output, JSON.stringify({ id, sidebar }));
        return;
      } else if (request.action === 'define' || request.action === 'update') {
        if ((request.action === 'define') === !!receipt) throw Error('fixture_wrong_phase');
        const version = request.action === 'define' ? 1 : 2;
        receipt = ctx.dynamicCordisRunner.define({ sessionId: owner,
          plugin: receipt ? { kind: 'existing', pluginId: receipt.pluginId } : { kind: 'new', idPrefix: 'dshm' },
          name: `Latest isolated Cordis v${version}`, purpose: 'Isolated real inventory lifecycle; no model or user files.',
          code: { host: 'return { apply() { harness.handle("echo", value => value); } };',
            client: `return { inject: ["slots"], apply(ctx) {
              ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
                name: "conversation.session.header.actions", id: "latest-isolated-cordis-echo"
              }, function Probe() {
                const [value, setValue] = React.useState("Latest Cordis echo v${version}");
                return React.createElement("button", { "data-testid": "latest-cordis-echo",
                  onClick: async () => { try { setValue(await host.call("echo", "LATEST_CORDIS_HOST_ECHO_V${version}")); }
                    catch (error) { setValue(error.message); } }
                }, value);
              }));
            } };` },
        });
      } else if (request.action === 'request' && receipt) {
        const found = await ctx.sessionController.resolveAgent(owner);
        if (found.error) throw found.error;
        const requested = await ctx.dynamicCordisRunner.run(found.agent, receipt.pluginId, receipt.packageId, 'run');
        if (!requested.ok || requested.status !== 'awaiting-approval') throw Error('fixture_approval_not_pending');
      } else if (request.action === 'remove' && receipt) {
        const found = await ctx.sessionController.resolveAgent(owner);
        if (found.error) throw found.error;
        const removed = await ctx.dynamicCordisRunner.undefine(found.agent, receipt.pluginId);
        if (!removed.ok) throw Error('fixture_remove_failed');
        receipt = undefined;
      } else throw Error('fixture_unknown_action');
      await writeFile(output, JSON.stringify({ id, receipt: receipt ?? null }));
    } catch (error) {
      if (error.code !== 'ENOENT') await writeFile(output, JSON.stringify({ id, error: error.message }));
    } finally { busy = false; }
  };
  const timer = setInterval(() => { void tick(); }, 50);
  ctx.effect(() => () => { closed = true; lifetime.abort(); clearInterval(timer); });
}
