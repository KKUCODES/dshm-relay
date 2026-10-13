import { randomUUID } from 'node:crypto'
import { expect, test } from 'vitest'
import { operationSchema, presetManagementViewSchema } from '../packages/protocol/src/index.js'

test('预设管理只接收固定身份和一次性快照，拒绝任意 YAML、配置、文件和未确认删除', () => {
  const copy = { method: 'remote.presetCopy', snapshot: randomUUID(), id: 'my-copy', name: '我的模式' }
  expect(operationSchema.parse(copy)).toEqual(copy)
  for (const invalid of [{ ...copy, snapshot: undefined }, { ...copy, path: 'C:/file' }, { ...copy, plugins: [] }, { ...copy, config: {} },
    ...['../preset', '', 'A', 'x'.repeat(129)].map(id => ({ ...copy, id })),
    ...['', 'x\nsecret', '\0', 'x'.repeat(257)].map(name => ({ ...copy, name }))]) expect(operationSchema.safeParse(invalid).success).toBe(false)
  expect(operationSchema.safeParse({ method: 'remote.presetManagementRead', preset: 'standard' }).success).toBe(true)
  for (const confirmed of [undefined, false, 1, 'true'])
    expect(operationSchema.safeParse({ method: 'remote.presetDelete', snapshot: copy.snapshot, confirmed }).success).toBe(false)
  expect(operationSchema.safeParse({ method: 'remote.presetDelete', snapshot: copy.snapshot, confirmed: true }).success).toBe(true)
  expect(presetManagementViewSchema.safeParse({ snapshot: copy.snapshot, preset: 'standard', canCopy: true, canDelete: false }).success).toBe(true)
  expect(presetManagementViewSchema.safeParse({ snapshot: copy.snapshot, preset: 'standard', canCopy: true, canDelete: false, plugins: [] }).success).toBe(false)
})
