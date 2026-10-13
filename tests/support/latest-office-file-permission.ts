import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { onTestFinished } from 'vitest'

/** 只修改本次独立文件的 Windows DACL；原备份留在旁边，超时结束钩子也恢复。 */
export async function latestOfficeFilePermission(filePath: string) {
  assert.equal(process.platform, 'win32')
  const binary = process.env.DSHM_PWSH_PATH
  assert.ok(binary && isAbsolute(binary), 'Specify the inspected PowerShell binary')
  const root = await realpath(resolve('../plugin/artifacts/latest-runtime-check/relay-homes'))
  const actual = await realpath(filePath)
  assert.match(relative(root, actual).replaceAll('\\', '/'),
    /^[0-9a-f-]{36}\/test-project\/latest-(office-transmission|mobile-inflight)\.docx$/)
  const source = await readFile(actual), run = promisify(execFile)
  const mutate = async (action: 'capture' | 'deny' | 'restore') => {
    const { stdout } = await run(binary, ['-NoProfile', '-File', resolve('tests/support/latest-office-file-acl.ps1'),
      '-FilePath', actual, '-Action', action], { cwd: resolve('.'), windowsHide: true, timeout: 10000 })
    const result = JSON.parse(stdout) as { action: string; aclHash: string; restored: boolean }
    assert.equal(result.action, action); assert.match(result.aclHash, /^[0-9a-f]{64}$/)
    return result
  }
  const baseline = await mutate('capture')
  let restored = false
  const restore = async () => {
    const result = await mutate('restore')
    assert.equal(result.aclHash, baseline.aclHash); assert.equal(result.restored, true)
    assert.deepEqual(await readFile(actual), source)
    restored = true
    return { aclRestoredExactly: true, originalBytesPreserved: true, aclHash: result.aclHash }
  }
  onTestFinished(async () => { if (!restored) await restore() })
  return {
    restore,
    async deny() {
      assert.equal(restored, false)
      const result = await mutate('deny')
      assert.notEqual(result.aclHash, baseline.aclHash)
      let code: string | undefined
      try { await readFile(actual) } catch (error) { code = (error as NodeJS.ErrnoException).code }
      assert.ok(code === 'EACCES' || code === 'EPERM', '原 Node 文件读取必须真实拒绝，不能仅检查 ACL 文本')
      return { realNodeReadDenied: true, code, aclHash: result.aclHash }
    },
  }
}
