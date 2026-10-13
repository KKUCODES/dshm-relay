import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect } from 'vitest'

type Window = { hwnd: number; path: string; application: string }

/** Real OS observation; close only the observed Explorer window at this fresh fixture path. */
export async function latestExplorerObservation(workspacePath: string) {
  assert.equal(process.platform, 'win32')
  const binary = process.env.DSHM_PWSH_PATH
  assert.ok(binary && isAbsolute(binary), 'Specify the inspected PowerShell binary')
  const fixtureRoot = await realpath(resolve('../plugin/artifacts/latest-runtime-check/relay-homes'))
  const actual = await realpath(workspacePath), local = relative(fixtureRoot, actual)
  assert.match(local.replaceAll('\\', '/'), /^[0-9a-f-]{36}\/test-project$/)
  const handles = new Set<number>()
  let currentHandles: number[] = []
  const run = promisify(execFile)
  const inspect = async (action = 'inspect', hwnd?: number): Promise<Window[]> => {
    const { stdout } = await run(binary, ['-NoProfile', '-File', resolve('tests/support/latest-explorer-window.ps1'),
      '-WorkspacePath', actual, '-Action', action, ...hwnd === undefined ? [] : ['-WindowHandle', String(hwnd)]],
    { cwd: resolve('.'), windowsHide: true, timeout: 10000 })
    const value = JSON.parse(stdout)
    assert.ok(Array.isArray(value.windows))
    assert.ok(Array.isArray(value.windowHandles) && value.windowHandles.every((handle: unknown) => Number.isSafeInteger(handle) && Number(handle) > 0))
    currentHandles = value.windowHandles
    for (const row of value.windows) {
      assert.ok(Number.isSafeInteger(row.hwnd) && row.hwnd > 0)
      assert.equal(row.application, 'explorer.exe')
      assert.equal(relative(actual, row.path), '')
    }
    return value.windows
  }
  assert.deepEqual(await inspect(), [], 'Fresh fixture must have no existing Explorer window')
  const baselineHandles = new Set(currentHandles)
  const close = async () => {
    // A launch may have completed just before an assertion timed out. Exact fresh path remains the ownership fence.
    for (const row of await inspect()) {
      assert.ok(!baselineHandles.has(row.hwnd), 'Do not close a shared pre-existing Explorer window')
      handles.add(row.hwnd)
    }
    for (const handle of handles) await inspect('close', handle)
    await expect.poll(async () => (await inspect()).length === 0
      && [...handles].every(handle => !currentHandles.includes(handle)), { timeout: 15000 }).toBe(true)
  }
  return {
    assertNotOpened: async () => {
      assert.deepEqual(await inspect(), [], 'Revoked request must not open the fixture workspace')
      return { noWorkspaceWindow: true }
    },
    opened: async () => {
      let windows: Window[] = []
      await expect.poll(async () => { windows = await inspect(); return windows.length }, { timeout: 30000 }).toBeGreaterThan(0)
      for (const row of windows) {
        assert.ok(!baselineHandles.has(row.hwnd), 'Launched folder reused a user window; do not close it')
        handles.add(row.hwnd)
      }
      return { observed: true, windows }
    },
    close,
  }
}
