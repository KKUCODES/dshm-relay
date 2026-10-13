import { readFile, writeFile, realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';

export const inject = ['dynamicCordisRunner', 'sessionController'];

/** 仅独立测试 home 的文件控制器；定义与审批均由原 Host 执行。 */
export async function apply(ctx) {
  const root = await realpath(resolve(import.meta.dirname, '../../../plugin/artifacts/latest-runtime-check/relay-homes'));
  const home = await realpath(process.env.DSH_HOME);
  const within = relative(root, home);
  if (!within || within.startsWith('..') || isAbsolute(within)) throw Error('race_fixture_outside_home');
  const input = resolve(home, 'race-control.json'), output = resolve(home, 'race-receipt.json');
  let seen, owner, receipt, version = 0, closed = false, busy = false;
  const tick = async () => {
    if (closed || busy) return;
    busy = true;
    let id;
    try {
      const request = JSON.parse(await readFile(input, 'utf8'));
      id = request.id;
      if (id === seen) return;
      if (!/^[0-9a-f-]{36}$/.test(id) || !/^latest-relay-[0-9a-f-]{36}$/.test(request.sessionId)) throw Error('race_fixture_invalid_request');
      seen = id;
      if (owner && owner !== request.sessionId) throw Error('race_fixture_owner_changed');
      owner = request.sessionId;
      let result;
      if (request.action === 'next') {
        if (request.failure !== undefined && !['host', 'client', 'handler', 'render', 'factory'].includes(request.failure)) throw Error('race_fixture_invalid_failure');
        if (++version > 7) throw Error('race_fixture_version_limit');
        const host = request.failure === 'host'
          ? `return { apply() { throw new Error("LATEST_RACE_HOST_APPLY_V${version}"); } };`
          : request.failure === 'handler'
            ? `return { apply() { harness.handle("echo", () => { throw new Error("LATEST_RACE_HANDLER_V${version}"); }); } };`
            : 'return { apply() { harness.handle("echo", value => value); } };';
        receipt = ctx.dynamicCordisRunner.define({ sessionId: owner,
          plugin: receipt ? { kind: 'existing', pluginId: receipt.pluginId } : { kind: 'new', idPrefix: 'dshm' },
          name: `Latest race v${version}`, purpose: 'Isolated two-client concurrency; no inference or user files.',
          code: { host,
            client: request.failure === 'client'
              ? `return { apply() { throw new Error("LATEST_RACE_CLIENT_APPLY_V${version}"); } };`
              : request.failure === 'factory'
                ? `return { inject: ["slots"], apply(ctx) {
                  ctx.slots.registerFactory({ name: "latest.race.factory", scope: "session" }, function FactoryProbe({ target }) {
                    const [value, setValue] = React.useState("Latest race Factory v${version}");
                    if (value === "CRASH") throw new Error("LATEST_RACE_FACTORY_RENDER_V${version}");
                    return React.createElement("button", {
                      "data-testid": target === "broken" ? "latest-race-echo" : "latest-race-survivor",
                      "data-version": "${version}", onClick: async () => {
                        if (target === "broken") { setValue("CRASH"); return; }
                        setValue(await host.call("echo", "LATEST_RACE_FACTORY_SURVIVOR"));
                      }
                    }, value);
                  });
                  ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
                    name: "conversation.session.header.actions", id: "latest-race-factory-parent"
                  }, function Parent({ renderFactorySlot }) {
                    return React.createElement(React.Fragment, null,
                      renderFactorySlot("latest.race.factory", { target: "broken" }),
                      renderFactorySlot("latest.race.factory", { target: "healthy" }));
                  }));
                } };`
              : `return { inject: ["slots"], apply(ctx) {
              ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
                name: "conversation.session.header.actions", id: "latest-race-echo"
              }, function Probe() {
                const [value, setValue] = React.useState("Latest race UI v${version}");
                ${request.failure === 'render' ? `if (value === "CRASH") throw new Error("LATEST_RACE_RENDER_V${version}");` : ''}
                return React.createElement("button", { "data-testid": "latest-race-echo", "data-version": "${version}",
                  onClick: async () => { ${request.failure === 'render' ? 'setValue("CRASH"); return;' : ''} try { setValue(await host.call("echo", "LATEST_RACE_HOST_V${version}")); }
                    catch (error) { setValue(error.message); } }
                }, value);
              }));
            } };` },
        });
      } else if (request.action === 'request' && receipt) {
        const found = await ctx.sessionController.resolveAgent(owner);
        if (found.error) throw found.error;
        const row = ctx.dynamicCordisRunner.inventory().find(row => row.pluginId === receipt.pluginId);
        result = await ctx.dynamicCordisRunner.run(found.agent, receipt.pluginId, receipt.packageId, row?.activeRun ? 'update' : 'run');
        if (!result.ok || result.status !== 'awaiting-approval') throw Error('race_fixture_request_not_pending');
      } else throw Error('race_fixture_invalid_action');
      await writeFile(output, JSON.stringify({ id, version, receipt, result }));
    } catch (error) {
      if (error.code !== 'ENOENT') await writeFile(output, JSON.stringify({ id, error: error.message }));
    } finally { busy = false; }
  };
  const timer = setInterval(() => { void tick(); }, 50);
  ctx.effect(() => () => { closed = true; clearInterval(timer); });
}
