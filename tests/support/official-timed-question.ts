import { createHash, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect } from 'vitest'

type Rpc = (method: string, args: unknown) => Promise<any>

/** 通过正常声明式插件新增隔离模式；不改标准模式、官方源码或启动入口。 */
export function officialTimedPreset(rpc: Rpc, directory: string, run: string) {
  // 官方解析器缓存同名link包路径；每轮唯一名称避免把重新链接误作运行时更新。
  const name = '@dsh-mobile/timed-question-verification-' + run.slice(0, 8)
  const id = 'dshm-timed-question-' + run.slice(0, 8)
  const fixture = resolve(directory, 'official-timed-fixtures', run)
  let original: any, standard: any, attempted = false
  return {
    id,
    async install() {
      original = await rpc('agentPresets/list', {})
      expect(original.presets.some((item: any) => item.id === id)).toBe(false)
      expect((await rpc('pluginManager/listBundles', {})).some((item: any) => item.name === name)).toBe(false)
      standard = await rpc('agentPresets/read', { agentPreset: 'standard' })
      const row = "- id: tool-ask-user\n  name: '@deepseek-ai/dsh-tool-ask-user'"
      // 精确要求官方公开文档的完整行，不猜测其他版本的配置结构。
      expect(standard.content.match(/- id: tool-ask-user[\s\S]*?(?=\n- id:|$)/g)).toEqual([row])
      const addition = '\n  config:\n    mode: timed\n    timeout: 120'
      const content = standard.content.replace(row, row + addition)
      expect(content.replace(row + addition, row)).toBe(standard.content)
      await mkdir(fixture, { recursive: true })
      await writeFile(resolve(fixture, 'package.json'), JSON.stringify({ name, version: '0.0.1',
        private: true, type: 'module', exports: { '.': './index.js', './package.json': './package.json' },
        files: ['index.js', 'cordis.patch.yml'], dsh: { bundle: { patch: './cordis.patch.yml' } },
      }, null, 2) + '\n', { flag: 'wx' })
      await writeFile(resolve(fixture, 'index.js'), 'export default function verificationBundle() {}\n', { flag: 'wx' })
      await writeFile(resolve(fixture, 'cordis.patch.yml'), [
        '- insert:', '    - id: ' + id, "      name: '@deepseek-ai/dsh-agent-preset'", '      config:',
        '        id: ' + id, '        name: DSHM带超时提问验收', '        plugins:',
        ...content.trimEnd().split('\n').map((line: string) => '          ' + line), '',
      ].join('\n'), { flag: 'wx' })
      attempted = true
      const result = await rpc('pluginManager/installBundle', { spec: fixture })
      expect(result.application, result.error?.diagnostic).not.toBe('failed')
      await expect.poll(async () => (await rpc('agentPresets/list', {})).presets
        .some((item: any) => item.id === id), { timeout: 120000 }).toBe(true)
      expect((await rpc('agentPresets/list', {})).presets.filter((item: any) => item.id !== id)).toEqual(original.presets)
      expect(await rpc('agentPresets/read', { agentPreset: 'standard' })).toEqual(standard)
      const installed = await rpc('agentPresets/read', { agentPreset: id })
      expect(installed.content).toBe(content)
      return { id, name, application: result.application, standardUnchanged: true,
        originalPresetDefaultsUnchanged: true, originalContentSha256: createHash('sha256').update(standard.content).digest('hex') }
    },
    async cleanup() {
      if (!attempted) return { installAttempted: false }
      const bundle = (await rpc('pluginManager/listBundles', {})).find((item: any) => item.name === name)
      if (bundle) {
        expect(bundle.version).toBe('0.0.1')
        expect(bundle.source.replaceAll('\\', '/')).toContain(fixture.replaceAll('\\', '/'))
        const result = await rpc('pluginManager/removeBundle', { name })
        expect(result.application, result.error?.diagnostic).not.toBe('failed')
      }
      await expect.poll(async () => (await rpc('pluginManager/listBundles', {}))
        .some((item: any) => item.name === name), { timeout: 120000 }).toBe(false)
      await expect.poll(async () => (await rpc('agentPresets/list', {})).presets
        .some((item: any) => item.id === id), { timeout: 30000 }).toBe(false)
      expect(await rpc('agentPresets/list', {})).toEqual(original)
      expect(await rpc('agentPresets/read', { agentPreset: 'standard' })).toEqual(standard)
      return { bundleRemoved: true, testPresetRemoved: true, standardUnchanged: true, originalPresetDefaultsUnchanged: true }
    },
  }
}

/** 核对真实工具、超时结果及迟到用户消息；不生成或替换任何模型/审批事件。 */
export function officialTimedQuestionChecks({ rpc, sessionId, readSession, verifyReply, observeInteraction }: {
  rpc: Rpc; sessionId: string; readSession: () => Promise<any>; verifyReply: (token: string) => Promise<any>;
  observeInteraction: (sessionId: string, callId: string, question: any) => Promise<any>;
}) {
  const prefixes = new Map<string, any[]>()
  const settled = async (token: string) => {
    await expect.poll(async () => {
      const current = await readSession()
      const reply = current.records.find((item: any) => item.event.type === 'assistant/message'
        && item.event.data.message.content.filter((part: any) => part.type === 'text')
          .map((part: any) => part.text).join('\n').trim() === token)
      return !!reply && current.records.some((item: any) => item.event.type === 'turn/end'
        && item.event.seq > reply.event.seq && item.event.data.reason.kind === 'completed')
    }, { timeout: 180000 }).toBe(true)
    await expect.poll(async () => (await rpc('session/list', { _request: {} })).items
      .find((item: any) => item.sessionId === sessionId)?.running, { timeout: 20000 }).toBe(false)
    return verifyReply(token)
  }
  return {
    async start(prompt: string) {
      const requestId = randomUUID()
      await rpc('session/prompt', { request: { sessionId, requestId, mode: 'queue', content: [{ type: 'text', text: prompt }] } })
      return { origin: 'official-desktop-public-session-prompt', requestId }
    },
    settled,
    async observe(seed: any) {
      const reader = await observeInteraction(sessionId, seed.callId,
        { id: seed.questionId, question: seed.question, timed: true })
      // 只读取原waterfall身份，立即关闭；不调用attachWait、不为手机维持倒计时。
      reader.close()
      return { ...reader.summary, waitClaimAttached: false, observerClosed: true }
    },
    async verify(seed: any, phase: 'open' | 'continued' | 'answered') {
      const current = await readSession()
      const events = current.records.map((item: any) => item.event)
      const calls = events.filter((item: any) => item.type === 'tool/call' && item.seq > seed.initialSeq)
      expect(calls).toHaveLength(1)
      const call = calls[0].data
      expect(call).toMatchObject({ name: 'ask_user_question', callId: seed.callId })
      const args = JSON.parse(call.arguments)
      expect(args.timeout).toBe(seed.timeout)
      expect(args.questions).toHaveLength(1)
      expect(args.questions[0]).toMatchObject({ id: seed.questionId, question: seed.question })
      expect(args.questions[0].options.map((item: any) => item.label)).toEqual(['蓝色', '绿色'])
      expect(args.questions[0].multi_select === true).toBe(false)
      const header = events.findLast((item: any) => item.type === 'request/header' && item.seq < calls[0].seq)
      expect(header.data.header.tools.find((item: any) => item.name === 'ask_user_question').parameters.properties)
        .toHaveProperty('timeout')
      expect(events.filter((item: any) => item.type === 'user/message'
        && item.data.content.some((part: any) => part.type === 'text' && part.text === seed.prompt))).toHaveLength(1)
      const results = events.filter((item: any) => item.type === 'tool/result' && item.data.message.toolCallId === seed.callId)
      expect(results).toHaveLength(phase === 'open' ? 0 : 1)
      const late = events.filter((item: any) => item.type === 'user/message'
        && item.data.source.kind === 'user-question-reply' && item.data.source.callId === seed.callId)
      expect(late).toHaveLength(phase === 'answered' && seed.kind === 'expired' ? 1 : 0)
      const questions = current.snapshot.values.userQuestions
      if (phase === 'answered') {
        expect(questions.active.some((item: any) => item.callId === seed.callId)).toBe(false)
        expect(questions.settled.filter((item: any) => item.callId === seed.callId))
          .toEqual([{ callId: seed.callId, answers: [{ id: seed.questionId, selected: [seed.selected] }] }])
      } else expect(questions.active.find((item: any) => item.callId === seed.callId))
        .toMatchObject({ callId: seed.callId, state: phase })
      if (results.length) {
        const message = results[0].data.message
        expect(message.isError === true).toBe(false)
        const value = JSON.parse(message.content.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n'))
        if (seed.kind === 'expired') {
          expect(value).toMatchObject({ pending: true, callId: seed.callId })
          expect(value).not.toHaveProperty('answers')
          expect(value.message).toContain('Do not treat this as permission.')
        } else expect(value).toEqual({ answers: [{ id: seed.questionId, selected: [seed.selected] }] })
      }
      if (late.length) {
        expect(late[0].data.source).toMatchObject({ kind: 'user-question-reply', callId: seed.callId, outcome: 'answered' })
        const value = JSON.parse(late[0].data.content.find((part: any) => part.type === 'text').text)
        expect(value).toMatchObject({ kind: 'answer_to_pending_question', tool: 'ask_user_question', callId: seed.callId,
          answers: [{ id: seed.questionId, selected: [seed.selected] }] })
        expect(value.questions[0]).toMatchObject({ id: seed.questionId, question: seed.question })
      }
      const before = prefixes.get(seed.callId)
      if (before) expect(current.records.slice(0, before.length)).toEqual(before)
      else { expect(phase).toBe('open'); prefixes.set(seed.callId, current.records) }
      const prefix = before ?? current.records
      return { phase, callId: seed.callId, timeout: args.timeout, toolCalls: 1, toolResults: results.length,
        resultSeq: results[0]?.seq, lateReplies: late.length, lateReplySeq: late[0]?.seq,
        originalRecords: prefix.length, currentRecords: current.records.length,
        originalPrefixSha256: createHash('sha256').update(JSON.stringify(prefix)).digest('hex'),
        timeoutIsNotPermission: seed.kind === 'expired' && phase !== 'open' }
    },
  }
}
