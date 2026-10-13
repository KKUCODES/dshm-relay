import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const delay = (ms: number) => new Promise(done => setTimeout(done, ms))

/** 只结束隔离官方CLI的已核对进程树；使用原pnpm入口重开同一home，不注入模块。 */
export function officialHostLifecycle(root: string, initial: any) {
  assert.equal(process.platform, 'win32')
  assert.equal(initial.entry, 'pnpm dsh web')
  const alpha2 = process.env.DSHM_OFFICIAL_ALPHA2_CHECK === '1'
  assert.equal(root, resolve('../plugin/artifacts', alpha2 ? 'official-dsh-alpha2' : 'official-dsh-plugin-only'))
  const port = alpha2 ? 16958 : 16955
  assert.equal(initial.port, port)
  assert.equal(String(initial.pid), process.env.DSHM_OFFICIAL_OWNED_LAUNCH_PID)
  assert.ok(!process.env.NODE_OPTIONS, 'Official restart must not inherit a runtime preload')
  const pnpmCli = process.env.DSHM_OFFICIAL_RESTART_PNPM_CLI
  assert.ok(pnpmCli?.endsWith('pnpm.cjs'))
  const receiptPath = resolve(root, 'official-web-receipt.json')
  let current = initial, stopped = false, launching = false
  const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
  const wait = async (predicate: () => Promise<boolean>, timeout: number) => {
    const start = Date.now()
    while (!await predicate()) {
      assert.ok(Date.now() - start < timeout, 'Official lifecycle observation timed out')
      await delay(250)
    }
  }
  return {
    isStopped: () => stopped,
    stop: async () => {
      assert.equal(stopped, false)
      const receipt = JSON.parse(await readFile(receiptPath, 'utf8'))
      assert.equal(receipt.run, current.run)
      assert.equal(receipt.pid, current.pid)
      assert.equal(receipt.stage, 'plugin-ready')
      assert.equal(receipt.privateLog, resolve(root, `web-${receipt.run}.private.log`))
      assert.equal(alive(receipt.pid), true)
      const killed = await execute('taskkill.exe', ['/PID', String(receipt.pid), '/T', '/F'], { windowsHide: true })
      stopped = true; launching = false
      await wait(async () => !alive(receipt.pid), 15000)
      await wait(async () => {
        try { await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) }); return false }
        catch { return true }
      }, 15000)
      return { oldRun: receipt.run, oldLaunchPid: receipt.pid, processTreeEnded: true,
        portClosed: true, taskkillOutput: killed.stdout.trim() }
    },
    start: async (telemetry?: { endpoint: string }) => {
      assert.equal(stopped, true)
      if (telemetry) assert.match(telemetry.endpoint, /^http:\/\/127\.0\.0\.1:\d+\/v1\/logs$/)
      // 观察超时不能作为再次启动的依据；同一次启动继续观察原回执和进程。
      if (!launching) {
        const child = spawn(process.execPath, [resolve(root, '../../scripts/run-official-dsh-web.mjs'), ...(alpha2 ? ['--alpha2'] : [])], {
          cwd: resolve(root, '../..'), detached: true, windowsHide: true, stdio: 'ignore',
          env: { ...process.env, DSHM_PNPM_CLI: pnpmCli, ...(telemetry ? {
            DSH_TELEMETRY_OTLP_URL: telemetry.endpoint, DSH_TELEMETRY_MODE: 'FEEDBACK_ONLY',
            DSH_TELEMETRY_DISABLED: undefined,
          } : {}) },
        })
        assert.ok(child.pid); child.unref(); launching = true
      }
      await wait(async () => {
        const receipt = JSON.parse(await readFile(receiptPath, 'utf8'))
        if (receipt.run === current.run) return false
        assert.ok(!['launch-failed', 'probe-failed', 'plugin-unavailable', 'exited'].includes(receipt.stage),
          `Official restart failed at ${receipt.stage}`)
        if (receipt.stage !== 'plugin-ready') return false
        assert.equal(receipt.entry, 'pnpm dsh web'); assert.equal(receipt.port, port)
        assert.equal(receipt.pluginStatus, 200); assert.equal(alive(receipt.pid), true)
        assert.equal(receipt.privateLog, resolve(root, `web-${receipt.run}.private.log`))
        return true
      }, 90000)
      const previous = current
      current = JSON.parse(await readFile(receiptPath, 'utf8'))
      assert.notEqual(current.pid, previous.pid)
      stopped = false
      return current
    },
  }
}
