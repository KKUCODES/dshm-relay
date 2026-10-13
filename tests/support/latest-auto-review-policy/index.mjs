// 仅为本机独立验收设置原审批策略；不生成工具结果、审批结果或模型响应。
import assert from 'node:assert/strict';
import { readFile, realpath } from 'node:fs/promises';
import { resolve, relative } from 'node:path';

export const inject = ['commands', 'approval', 'agents', 'permissionPresets'];
export async function apply(ctx) {
  const root = resolve(import.meta.dirname, '../../../../plugin/artifacts/latest-runtime-check/live-homes');
  const home = resolve(process.env.DSH_HOME ?? '');
  assert.match(relative(root, home), /^[0-9a-f-]{36}$/);
  assert.equal(await realpath(home), resolve(await realpath(root), relative(root, home)));
  ctx.commands.register({
    definitionId: '@dsh-mobile/latest-auto-review-policy',
    name: 'dshm-latest-review-policy',
    description: 'Set the original never policy for the owned Auto review test',
    input: { hint: '<test-marker> never' },
    handler: async ({ agent, rawInput }) => {
      const control = JSON.parse(await readFile(resolve(home, 'latest-auto-review-control.json'), 'utf8'));
      assert.equal(control.phase, 'native-deny-never');
      assert.match(control.marker, /^DSHM_LATEST_AUTO_[a-f0-9]{32}$/);
      assert.match(control.sessionId, /^session-[0-9a-f-]{36}$/);
      assert.equal(rawInput.trim(), control.marker + ' never');
      assert.equal(agent.session.header.id, control.sessionId);
      assert.equal(ctx.agents.get(agent.id), agent);
      assert.equal(ctx.permissionPresets.current(agent.session), 'auto');
      assert.equal(ctx.approval.overrideOf(agent.session), 'ask');
      // 原服务负责持久事件与下一步模型通知；不直接写入Session日志。
      ctx.approval.setPolicy(agent, 'never');
      assert.equal(ctx.approval.overrideOf(agent.session), 'never');
      assert.equal(ctx.permissionPresets.current(agent.session), 'auto');
      return { kind: 'success', text: control.marker + '_POLICY_NEVER' };
    },
  });
}
