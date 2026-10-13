import { expect, test } from 'vitest'
import { randomUUID } from 'node:crypto'
import { operationSchema, isStream } from '../packages/protocol/src/index.js'

test('指定应用只接受会话、应用标识和一次性确认，不接受任意启动参数', () => {
  const list = { method: 'remote.desktopApps', sessionId: 'own' }
  const prepare = { method: 'remote.prepareDesktopApp', sessionId: 'own', appId: 'vscode' }
  const open = { method: 'remote.openDesktopApp', sessionId: 'own', snapshot: randomUUID(), confirmed: true }
  const icon = { method: 'remote.desktopAppIcon', sessionId: 'own', appId: 'vscode' }
  for (const request of [list, prepare, open, icon]) {
    expect(isStream(operationSchema.parse(request))).toBe(false)
    for (const extra of [{ path: 'C:/another' }, { cwd: '/' }, { command: 'x' }, { args: [] }, { deviceId: 'forged' }])
      expect(operationSchema.safeParse({ ...request, ...extra }).success).toBe(false)
  }
  for (const appId of ['', 'C:/code.exe', '--help', 'vscode\n', 'a'.repeat(81)])
    expect(operationSchema.safeParse({ ...prepare, appId }).success).toBe(false)
  for (const extra of [{ confirmed: false }, { snapshot: 'old' }, { appId: 'other' }])
    expect(operationSchema.safeParse({ ...open, ...extra }).success).toBe(false)
})

test('附件打开只接受引用与单次确认，不接受磁盘路径或伪造身份', () => {
  const prepare = { method: 'remote.prepareDesktopAttachment', sessionId: 'own', kind: 'file', attachmentId: 'opaque', name: 'old.txt' }
  const open = { method: 'remote.openDesktopAttachment', sessionId: 'own', snapshot: randomUUID(), confirmed: true }
  for (const request of [prepare, open]) {
    expect(isStream(operationSchema.parse(request))).toBe(false)
    for (const patch of [{ path: 'C:/old.txt' }, { command: 'x' }, { deviceId: 'forged' }, { url: 'https://example.invalid' }])
      expect(operationSchema.safeParse({ ...request, ...patch }).success).toBe(false)
  }
  for (const patch of [{ snapshot: 'bad' }, { confirmed: false }, { attachmentId: 'override' }])
    expect(operationSchema.safeParse({ ...open, ...patch }).success).toBe(false)
})

test('电脑打开仅允许已确认的交付或改动记录坐标，定位文件仅支持原交付记录', () => {
  expect(operationSchema.parse({ method: 'remote.desktop' })).toEqual({ method: 'remote.desktop' })
  const request = { method: 'remote.openFile', source: 'presented', sessionId: 'own', seq: 2, index: 0, confirmed: true }
  for (const source of ['presented', 'changes']) expect(isStream(operationSchema.parse({ ...request, source }))).toBe(false)
  expect(operationSchema.parse({ ...request, action: 'reveal' })).toEqual({ ...request, action: 'reveal' })
  for (const patch of [{ source: 'path' }, { sessionId: '' }, { seq: -1 }, { index: 0.5 }, { confirmed: false },
    { path: 'C:/secret' }, { url: 'https://example.invalid' }, { command: 'anything' }, { action: 'execute' },
    { action: 'reveal', source: 'changes' }, { index: Number.MAX_SAFE_INTEGER + 1 }]) {
    expect(operationSchema.safeParse({ ...request, ...patch }).success).toBe(false)
  }
  expect(operationSchema.safeParse({ ...request, confirmed: undefined }).success).toBe(false)
  expect(operationSchema.safeParse({ method: 'remote.desktop', path: '/' }).success).toBe(false)
})

test('普通文件仅准备受控路径，最终打开仅接受已确认的服务端快照', () => {
  const prepare = { method: 'remote.prepareDesktopFile', sessionId: 'own', path: 'src/file.ts' }
  for (const path of ['src/file.ts', '../file.txt', 'C:/files/file.txt']) expect(isStream(operationSchema.parse({ ...prepare, path }))).toBe(false)
  for (const path of ['', 'http://host', 'file:///etc/x', '//host/share', '\\\\host\\share', 'x\n', 'x\0', 'x'.repeat(4097)])
    expect(operationSchema.safeParse({ ...prepare, path }).success).toBe(false)
  const open = { method: 'remote.openDesktopFile', sessionId: 'own', snapshot: randomUUID(), confirmed: true }
  expect(isStream(operationSchema.parse(open))).toBe(false)
  for (const patch of [{ path: 'C:/another' }, { confirmed: false }, { snapshot: 'bad' }, { sessionId: '' }, { command: 'x' }, { owner: 'forged' }])
    expect(operationSchema.safeParse({ ...open, ...patch }).success).toBe(false)
})
