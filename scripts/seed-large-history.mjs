import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** 只向调用者创建的隔离home写入夹具；使用原官方持久化API，不修改DSH或调用模型。 */
export async function seedLargeHistory(sdk, home, cwd) {
  const require = createRequire(resolve(sdk, 'node_modules/@deepseek-ai/dsh/package.json'));
  const load = id => import(pathToFileURL(require.resolve(id)).href);
  const [{ Context }, persistence, { SESSION_FORMAT_VERSION, SessionId }, { createToolResultMessage }] = await Promise.all([
    load('@deepseek-ai/cordis'), load('@deepseek-ai/dsh-session-persistence-jsonl'), load('@deepseek-ai/dsh-session'),
    load('@deepseek-ai/dsh-llm'),
  ]);
  const ctx = new Context(), sessionId = 'dshm-large-response-fixture', title = 'DSHM 大响应验收';
  try {
    await ctx.plugin(persistence, { root: resolve(home, 'sessions') });
    const createdAt = Date.now(), events = [];
    const append = (type, data, surfaceOp) => events.push({ type, data, seq: events.length, time: createdAt + events.length, ...(surfaceOp ? { surfaceOp } : {}) });
    // 两个大回合分别位于默认尾部窗口和历史页内，避免只测一个入口。
    for (let turn = 1; turn <= 60; turn++) {
      const marker = turn === 1 ? '历史分页验收' : turn === 60 ? '首次快照验收' : `普通回合 ${turn}`;
      const text = `${marker}，仅用于传输验收。`;
      append('turn/start', { turn });
      append('user/message', { id: `fixture-user-${turn}`, role: 'user', content: [{ type: 'text', text: `${marker}，请查看结果。` }], source: { kind: 'user' } }, 'append');
      append('step/start', { turn, step: 1 });
      const time = createdAt + events.length, block = { type: 'text', text };
      const tool = turn === 1 || turn === 60 ? { type: 'tool-call', id: `fixture-read-${turn}`, name: 'read_file', arguments: '{"path":"fixture.txt"}' } : undefined;
      append('assistant/message', { turn, step: 1, message: { id: `fixture-assistant-${turn}`, role: 'assistant', content: tool ? [block, tool] : [block], source: { kind: 'model', provider: 'fixture', model: 'fixture-no-inference' } }, stream: [
        { type: 'chunk', time, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
        { type: 'text-chunks', time0: time, index: 0, dt: [], texts: [text] },
        { type: 'chunk', time, chunk: { type: 'block-end', index: 0, block } },
        ...tool ? [
          { type: 'chunk', time, chunk: { type: 'block-start', index: 1, blockType: 'tool-call' } },
          { type: 'chunk', time, chunk: { type: 'block-end', index: 1, block: tool } },
        ] : [],
        { type: 'chunk', time, chunk: { type: 'finish', reason: { kind: tool ? 'tool-calls' : 'stop' } } },
      ] }, 'append');
      if (turn === 1 || turn === 60) {
        const callId = `fixture-read-${turn}`;
        append('tool/call', { turn, step: 1, callId, name: 'read_file', arguments: '{"path":"fixture.txt"}' });
        append('tool/result', { turn, step: 1, message: createToolResultMessage({ callId, isError: false,
          content: [{ type: 'text', text: `${marker}：完整夹具输出\n` + 'fixture-data-0123456789\n'.repeat(100000) }] }) }, 'append');
      }
      append('step/end', { turn, step: 1 });
      append('turn/end', { turn, reason: { kind: 'completed' } });
    }
    append('session/title', { title, source: { kind: 'user' }, messageSeqs: [] });
    const handle = await ctx.sessionPersistence.create({ version: SESSION_FORMAT_VERSION, id: SessionId(sessionId), createdAt, isSeeded: false, cwd });
    await handle.append(events); await handle.close();
    assert.ok(Buffer.byteLength(JSON.stringify(events.at(-4))) > 2 * 1024 * 1024);
    return { sessionId, title, turns: 60, events: events.length, fixture: true, inference: false };
  } finally { await ctx.fiber.dispose(); }
}
