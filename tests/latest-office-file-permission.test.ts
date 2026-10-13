import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect, test } from 'vitest'
import { latestOfficeFilePermission } from './support/latest-office-file-permission.js'

test.skipIf(process.platform !== 'win32' || !process.env.DSHM_PWSH_PATH)('专用 Windows 文件真实读取被拒绝后恢复原 DACL 与字节', async () => {
  const workspace = resolve('../plugin/artifacts/latest-runtime-check/relay-homes', randomUUID(), 'test-project')
  await mkdir(workspace, { recursive: true })
  const path = resolve(workspace, 'latest-office-transmission.docx'), original = Buffer.from('DSHM ACL fixture 中文')
  await writeFile(path, original)
  const acl = await latestOfficeFilePermission(path)
  try {
    const denied = await acl.deny()
    expect(denied.realNodeReadDenied).toBe(true)
    expect(['EACCES', 'EPERM']).toContain(denied.code)
    expect(await acl.restore()).toMatchObject({ aclRestoredExactly: true, originalBytesPreserved: true })
    expect(await readFile(path)).toEqual(original)
  } finally { await acl.restore() }
}, 30000)

test.skipIf(process.platform !== 'win32' || !process.env.DSHM_PWSH_PATH)('拒绝操作非专用文件且保持原字节', async () => {
  const workspace = resolve('../plugin/artifacts/latest-runtime-check/relay-homes', randomUUID(), 'test-project')
  await mkdir(workspace, { recursive: true })
  const path = resolve(workspace, 'not-an-office-fixture.txt'), original = Buffer.from('Do not change access')
  await writeFile(path, original)
  await expect(latestOfficeFilePermission(path)).rejects.toThrow()
  expect(await readFile(path)).toEqual(original)
})
