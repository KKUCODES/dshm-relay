import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect } from 'vitest'

/** 只观察实际原生窗口；不替换官方 opener、路由或文件服务。 */
export function officialDesktopWindows(file: string) {
  const execute = promisify(execFile)
  const script = resolve('tests/support/official-desktop-window.ps1')
  let before: { notepadAbsent: boolean; explorerHandles: number[] } | undefined
  const inspect = async (mode: string) => {
    const result = await execute('pwsh.exe', ['-File', script, '-Mode', mode, '-FilePath', file],
      { cwd: process.cwd(), windowsHide: true, maxBuffer: 1024 * 1024 })
    return JSON.parse(result.stdout)
  }
  const cleanup = async () => {
    let state: Record<string, any> | undefined
    await expect.poll(async () => {
      const current = await inspect('cleanup')
      state = current
      return current.ownedExplorerWindows === 0 && current.ownedNotepadWindows === 0
    }, { timeout: 10000 }).toBe(true)
    return state!
  }
  return {
    snapshot: async () => {
      before = await inspect('snapshot')
      expect(before!.notepadAbsent).toBe(true)
      return before
    },
    verify: async (action: 'open' | 'reveal') => {
      expect(before).toBeDefined()
      let result: Record<string, unknown> | undefined
      let failure = ''
      try {
        await expect.poll(async () => {
          try { result = await inspect(action === 'open' ? 'opened' : 'revealed'); return true }
          catch (error) { failure = String((error as { stderr?: string }).stderr ?? error); return false }
        }, { timeout: 15000 }).toBe(true)
      } catch { throw new Error('Native desktop inspection failed: ' + failure.slice(-2000)) }
      const restored = await cleanup()
      expect(restored.explorerHandles.sort()).toEqual(before!.explorerHandles.sort())
      return { ...result, unrelatedExplorerPreserved: true, ownedWindowsClosed: true }
    },
    cleanup,
  }
}
