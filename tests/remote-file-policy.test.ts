import { expect, test } from 'vitest'
import { remotePermission, remoteRequestAllowed } from '../packages/protocol/src/remote-policy.js'
import { MAX_OFFICE_PDF_BYTES, MAX_UPLOAD_BYTES, attachmentRefSchema, attachmentOfficeMetadataSchema, isStream, officeMetadataSchema, operationSchema } from '../packages/protocol/src/index.js'

test('Office 缓存只读代次必须空参数，转换优先级只接受两种已审阅值', () => {
  expect(remotePermission('officeToPdf/generation', false)).toBe('basic')
  expect(remotePermission('officeToPdf/generation', true)).toBeUndefined()
  expect(remotePermission('officeToPdf/render', false)).toBeUndefined()
  expect(remoteRequestAllowed('officeToPdf/generation', { args: {} })).toBe(true)
  for (const payload of [{}, { args: null }, { args: [] }, { args: { path: 'a.docx' } }, { args: {}, context: {} }])
    expect(remoteRequestAllowed('officeToPdf/generation', payload)).toBe(false)
  for (const operation of [{ method: 'remote.office', sessionId: 's', path: 'a.docx' },
    { method: 'remote.attachmentOffice', sessionId: 's', attachmentId: 'id', name: 'a.docx' }]) {
    for (const priority of [undefined, 'foreground', 'background']) expect(operationSchema.safeParse({ ...operation, priority }).success).toBe(true)
    for (const priority of [null, true, 'urgent', 1]) expect(operationSchema.safeParse({ ...operation, priority }).success).toBe(false)
  }
})

test('按需目录只接受原会话与路径，不允许注入根目录、递归或枚举上限', () => {
  const endpoint = 'workspaceFiles/list', valid = { workspaceFileScopeId: 'session', path: '.' }
  expect(remotePermission(endpoint, false)).toBe('basic')
  expect(remotePermission(endpoint, true)).toBeUndefined()
  expect(remoteRequestAllowed(endpoint, { args: valid })).toBe(true)
  for (const args of [null, [], {}, { ...valid, path: '' }, { ...valid, path: 'x'.repeat(4097) },
    { ...valid, path: 'x\0y' }, { ...valid, workspaceFileScopeId: 'x\ny' }, { ...valid, workspaceFileScopeId: 'x'.repeat(201) },
    ...['workspaceRoot', 'workspaceFileScope', 'recursive', 'maxEntries', 'cwd', 'sessionId'].map(key => ({ ...valid, [key]: '/' }))]) {
    expect(remoteRequestAllowed(endpoint, { args })).toBe(false)
  }
})

test('文件观察只接受原会话 lookup 身份，不允许目录注入或普通 RPC', () => {
  const endpoint = 'workspaceFiles/changes'
  expect(remotePermission(endpoint, true)).toBe('basic')
  expect(remotePermission(endpoint, false)).toBeUndefined()
  expect(remoteRequestAllowed(endpoint, { args: { workspaceFileScopeId: 'existing-session' } })).toBe(true)
  for (const args of [undefined, null, [], {}, { workspaceFileScopeId: '' }, { workspaceFileScopeId: 'a'.repeat(201) },
    { workspaceFileScopeId: 'bad\0id' }, { workspaceFileScopeId: 'bad\nid' }, { workspaceFileScopeId: 1 },
    ...['path', 'workspaceRoot', 'workspaceFileScope', 'sessionId', 'recursive'].map(key => ({ workspaceFileScopeId: 's', [key]: '/' }))]) {
    expect(remoteRequestAllowed(endpoint, { args })).toBe(false)
  }
})

test('差异只接受原会话/公告/文件索引，不开放任意 HTTP 和路径', () => {
  const valid = { method: 'remote.changes', sessionId: 'session', seq: 1 }
  expect(isStream(operationSchema.parse(valid))).toBe(true)
  expect(operationSchema.safeParse({ ...valid, index: 0 }).success).toBe(true)
  for (const invalid of [{ ...valid, seq: -1 }, { ...valid, seq: 0.5 }, { ...valid, seq: Number.MAX_SAFE_INTEGER + 1 },
    { ...valid, index: -1 }, { ...valid, index: 0.1 }, { ...valid, sessionId: '' },
    ...['path', 'endpoint', 'url', 'headers', 'context', 'before', 'after'].map(key => ({ ...valid, [key]: 'extra' }))]) {
    expect(operationSchema.safeParse(invalid).success).toBe(false)
  }
  expect(remotePermission('changes.diff', false)).toBeUndefined()
  expect(remotePermission('changes.open', false)).toBeUndefined()
})

test('新版单目标观察与有界options由固定Host契约区分，网关仍拒绝根目录注入与无界读取', () => {
  const endpoint = 'workspaceFiles/changes', legacy = { args: { workspaceFileScopeId: 's' } }
  const target = { args: { workspaceFileScopeId: 's', path: '.' } }
  expect(remoteRequestAllowed(endpoint, legacy, 'target')).toBe(false)
  expect(remoteRequestAllowed(endpoint, target)).toBe(false)
  for (const contract of ['target', 'either'] as const) {
    expect(remoteRequestAllowed(endpoint, target, contract)).toBe(true)
    for (const invalid of [{ ...target, context: {} }, { args: { ...target.args, path: '' } },
      { args: { ...target.args, path: 'x'.repeat(4097) } }, { args: { ...target.args, path: 'x\0y' } },
      ...['recursive', 'workspaceRoot', 'cwd', 'maxEntries'].map(key => ({ args: { ...target.args, [key]: '/' } }))])
      expect(remoteRequestAllowed(endpoint, invalid, contract)).toBe(false)
  }
  expect(remoteRequestAllowed(endpoint, legacy, 'either')).toBe(true)
  const read = 'workspaceFiles/readBytes', args = { workspaceFileScopeId: 's', path: 'a.txt', options: { range: { offset: 0, length: 65536 } } }
  expect(remoteRequestAllowed(read, { args })).toBe(false)
  for (const contract of ['target', 'either'] as const) {
    expect(remoteRequestAllowed(read, { args }, contract)).toBe(true)
    expect(remoteRequestAllowed(read, { args: { ...args, options: { ...args.options, baseFile: 'src/base.txt' } } }, contract)).toBe(true)
    for (const invalid of [{ ...args, range: args.options.range }, { ...args, options: {} },
      { ...args, options: { range: { offset: 0, length: 65537 } } }, { ...args, options: { range: { offset: 0, length: 1, recursive: true } } },
      { ...args, options: { range: args.options.range, baseFile: 'x\0y' } }, { ...args, options: { range: args.options.range, maxBytes: 1 } },
      { ...args, workspaceRoot: '/' }]) expect(remoteRequestAllowed(read, { args: invalid }, contract)).toBe(false)
  }
})

test('文件读取只开放 Host stat 和有界字节窗，不能直接读取大 JSON 或修改文件', () => {
  const args = { workspaceFileScopeId: 'session', path: 'src/main.ts', range: { offset: 0, length: 65536 } }
  expect(remotePermission('workspaceFiles/readBytes', false)).toBe('basic')
  expect(remotePermission('workspaceFiles/stat', false)).toBe('basic')
  expect(remoteRequestAllowed('workspaceFiles/readBytes', { args })).toBe(true)
  for (const range of [undefined, {}, { offset: 0 }, { offset: -1, length: 1 }, { offset: 0.5, length: 1 }, { offset: 0, length: 65537 }, { offset: 0, length: 0 }, { offset: Number.MAX_SAFE_INTEGER, length: 1 }]) {
    expect(remoteRequestAllowed('workspaceFiles/readBytes', { args: { ...args, range } })).toBe(false)
  }
  for (const invalid of [{ ...args, workspaceFileScopeId: '' }, { ...args, path: '' }, { ...args, path: 'bad\0path' }]) {
    expect(remoteRequestAllowed('workspaceFiles/stat', { args: invalid })).toBe(false)
  }
  for (const endpoint of ['workspaceFiles/readAll', 'workspaceFiles/readRelated', 'workspaceFiles/write']) expect(remotePermission(endpoint, false)).toBeUndefined()
  expect(remotePermission('workspaceFiles/readBytes', true)).toBeUndefined()
})

test('原文件预览按行分页只接受会话、路径和有界的1-based窗口', () => {
  const endpoint = 'workspaceFiles/read', args = { workspaceFileScopeId: 'session', path: '目录/正文.txt', range: { offset: 1 } }
  expect(remotePermission(endpoint, false)).toBe('basic')
  expect(remotePermission(endpoint, true)).toBeUndefined()
  expect(remoteRequestAllowed(endpoint, { args })).toBe(true)
  expect(remoteRequestAllowed(endpoint, { args: { ...args, range: { offset: 5001, limit: 5000 } } })).toBe(true)
  for (const range of [null, [], {}, { offset: 0 }, { offset: 1.5 }, { offset: -1 }, { offset: Number.MAX_SAFE_INTEGER },
    { offset: 1, limit: 0 }, { offset: 1, limit: 1.5 }, { offset: 1, limit: 5001 }, { offset: 1, length: 100 },
    { offset: 1, maxBytes: 1 }, { offset: 1, limit: null }])
    expect(remoteRequestAllowed(endpoint, { args: { ...args, range } })).toBe(false)
  for (const invalid of [null, [], {}, { ...args, path: '' }, { ...args, path: 'x\0y' }, { ...args, path: 'x'.repeat(4097) },
    { ...args, workspaceFileScopeId: '' }, { ...args, workspaceFileScopeId: 'x\ny' }, { ...args, workspaceFileScopeId: 'x'.repeat(201) },
    ...['workspaceRoot', 'workspaceFileScope', 'cwd', 'maxBytes', 'recursive'].map(key => ({ ...args, [key]: '/' }))])
    expect(remoteRequestAllowed(endpoint, { args: invalid })).toBe(false)
  expect(remoteRequestAllowed(endpoint, { args, workspaceRoot: '/' })).toBe(false)
})

test('Office 只能走限定格式的分片流，不能绕过通道索取整份转换 JSON', () => {
  for (const extension of ['doc', 'DOCX', 'xls', 'xlsx', 'ppt', 'pptx']) {
    const operation = operationSchema.parse({ method: 'remote.office', sessionId: 'session', path: `docs/example.${extension}` })
    expect(isStream(operation)).toBe(true)
  }
  const valid = { method: 'remote.office', sessionId: 'session', path: 'docs/example.docx' }
  for (const invalid of [
    { ...valid, sessionId: '' }, { ...valid, path: 'file.pdf' }, { ...valid, path: 'file.docx.exe' },
    { ...valid, path: 'bad\0file.docx' }, { ...valid, path: `${'x'.repeat(4096)}.docx` },
    { ...valid, endpoint: 'workspaceFiles/readAll' }, { ...valid, priority: 'urgent' },
  ]) expect(operationSchema.safeParse(invalid).success).toBe(false)
  for (const endpoint of ['officeToPdf/render']) {
    expect(remotePermission(endpoint, false)).toBeUndefined()
    expect(remotePermission(endpoint, true)).toBeUndefined()
  }
  const metadata = { absolutePath: '/docs/example.docx', version: '1', bytes: MAX_OFFICE_PDF_BYTES, generation: 'provider', missingFonts: [] }
  expect(officeMetadataSchema.safeParse(metadata).success).toBe(true)
  for (const invalid of [{ ...metadata, bytes: MAX_OFFICE_PDF_BYTES + 1 }, { ...metadata, bytes: 0 },
    { ...metadata, generation: '' }, { ...metadata, missingFonts: Array(257).fill('font') },
    { ...metadata, data: 'unbounded' }]) expect(officeMetadataSchema.safeParse(invalid).success).toBe(false)
})

test('附件流只接受会话引用，不接受文件路径、伪造上下文或整份内容', () => {
  const valid = { method: 'remote.attachment', sessionId: 'session', kind: 'file', attachmentId: 'opaque:ref', name: '附件.txt' }
  expect(isStream(operationSchema.parse(valid))).toBe(true)
  expect(isStream(operationSchema.parse({ method: 'remote.attachment', sessionId: 'session', kind: 'image', attachmentId: 'opaque:image' }))).toBe(true)
  for (const invalid of [
    { ...valid, sessionId: '' }, { ...valid, attachmentId: '' }, { ...valid, attachmentId: 'a'.repeat(513) },
    { ...valid, kind: 'path' }, { ...valid, name: '' }, { ...valid, name: 'a'.repeat(256) },
    { ...valid, path: '/private/file.txt' }, { ...valid, context: { management: true } }, { ...valid, data: 'unbounded' },
  ]) expect(operationSchema.safeParse(invalid).success).toBe(false)
  const ref = { attachmentId: 'opaque:ref', name: '附件.txt', bytes: MAX_UPLOAD_BYTES }
  expect(attachmentRefSchema.safeParse(ref).success).toBe(true)
  for (const invalid of [{ ...ref, bytes: MAX_UPLOAD_BYTES + 1 }, { ...ref, bytes: -1 }, { ...ref, bytes: 0.5 },
    { ...ref, path: '/private/file.txt' }, { ...ref, mediaType: 'text/html' }, { ...ref, width: 0 }]) {
    expect(attachmentRefSchema.safeParse(invalid).success).toBe(false)
  }
})

test('图片消息通道不能指定其他 endpoint 或附带大 JSON 字段', () => {
  const valid = { method: 'remote.prompt', rpcId: '12345678-1234-4234-8234-123456789012' }
  expect(isStream(operationSchema.parse(valid))).toBe(true)
  for (const endpoint of ['session/prompt', 'subagents/prompt']) expect(operationSchema.safeParse({ ...valid, endpoint }).success).toBe(true)
  for (const endpoint of ['terminal/write', 'subagents/start', '/subagents/prompt', 'subagents/prompt?x=1']) expect(operationSchema.safeParse({ ...valid, endpoint }).success).toBe(false)
  for (const key of ['endpoint', 'path', 'data', 'payload', 'context']) expect(operationSchema.safeParse({ ...valid, [key]: 'extra' }).success).toBe(false)
})

test('Office 附件使用原引用和限定格式，不能传电脑路径或任意转换参数', () => {
  const valid = { method: 'remote.attachmentOffice', sessionId: 'session', attachmentId: 'opaque', name: '附件.docx' }
  for (const extension of ['doc', 'DOCX', 'xls', 'xlsx', 'ppt', 'pptx']) {
    expect(isStream(operationSchema.parse({ ...valid, name: `附件.${extension}` }))).toBe(true)
  }
  for (const invalid of [{ ...valid, sessionId: '' }, { ...valid, attachmentId: '' }, { ...valid, name: 'a.docx.exe' },
    { ...valid, name: '../a.docx' }, { ...valid, name: 'C:\\a.docx' }, { ...valid, name: 'bad\0.docx' },
    ...['path', 'priority', 'data', 'context', 'endpoint'].map(key => ({ ...valid, [key]: 'extra' }))]) {
    expect(operationSchema.safeParse(invalid).success).toBe(false)
  }
  const metadata = { attachmentId: 'opaque', name: '附件.docx', bytes: 7, generation: 'g1', missingFonts: [] }
  expect(attachmentOfficeMetadataSchema.safeParse(metadata).success).toBe(true)
  for (const invalid of [{ ...metadata, bytes: MAX_OFFICE_PDF_BYTES + 1 }, { ...metadata, bytes: 0 },
    { ...metadata, absolutePath: '/private/a.docx' }, { ...metadata, version: '1' }]) expect(attachmentOfficeMetadataSchema.safeParse(invalid).success).toBe(false)
})
