import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { expect, onTestFinished, test, vi } from 'vitest'
import { latestHostCleanup } from './support/latest-host-cleanup.js'

const failure = vi.hoisted(() => ({ mode: 'none' as 'none' | 'before' | 'after', calls: 0 }))
vi.mock('node:child_process', async importOriginal => {
  const original = await importOriginal<typeof import('node:child_process')>()
  return { ...original, execFileSync: (...args: Parameters<typeof original.execFileSync>) => {
    if (args[0] !== 'taskkill') return original.execFileSync(...args)
    failure.calls++
    if (failure.mode === 'before') throw new Error('fixture_taskkill_denied')
    const result = original.execFileSync(...args)
    // 保留真实 /T 系统调用及真实进程，仅制造其成功回收后非零退出的边界。
    if (failure.mode === 'after') throw new Error('fixture_taskkill_exit_race')
    return result
  } }
})

let host: ChildProcess | undefined
let descendantPid: number | undefined
const alive = (pid: number) => {
  try { process.kill(pid, 0); return true }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error }
}

test.fails('实际测试体超时后仍回收拥有的Host及Windows子进程', async () => {
  const hosts = new Set<ChildProcess>()
  const stop = latestHostCleanup(hosts, true, process.cwd())
  onTestFinished(() => { for (const owned of hosts) { stop(owned); stop(owned) } })
  host = spawn(process.execPath, ['-e',
    "const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true}); console.log(child.pid); setInterval(()=>{},1000)"],
    { cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
  hosts.add(host)
  const [output] = await once(host.stdout!, 'data')
  descendantPid = Number(output.toString().trim())
  expect(alive(host.pid!)).toBe(true)
  expect(alive(descendantPid!)).toBe(true)
  // 不触发finally清理：真实Vitest时限必须触发测试结束钩子。
  await new Promise(() => {})
}, 1500)

test('超时回收后没有存活的本测试进程', async () => {
  expect(host?.pid).toEqual(expect.any(Number))
  await expect.poll(() => alive(host!.pid!)).toBe(false)
  if (process.platform === 'win32') await expect.poll(() => alive(descendantPid!)).toBe(false)
  else process.kill(descendantPid!, 'SIGTERM')
})

test.skipIf(process.platform !== 'win32')('树回收后的非零结果不重复杀PID；存活时的清理错误仍拒绝', async () => {
  const owned = spawn(process.execPath, ['-e',
    "const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true}); console.log(child.pid); setInterval(()=>{},1000)"],
    { cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
  const hosts = new Set([owned]), stop = latestHostCleanup(hosts, true, process.cwd())
  const closed = once(owned, 'close')
  const [output] = await once(owned.stdout!, 'data')
  const childPid = Number(output.toString().trim())
  try {
    failure.mode = 'before'
    expect(() => stop(owned)).toThrow('fixture_taskkill_denied')
    expect(alive(owned.pid!)).toBe(true); expect(alive(childPid)).toBe(true)
    failure.mode = 'after'
    expect(() => stop(owned)).not.toThrow()
    const calls = failure.calls
    stop(owned); expect(failure.calls).toBe(calls)
    await closed
    expect(alive(owned.pid!)).toBe(false)
    await expect.poll(() => alive(childPid)).toBe(false)
  } finally { failure.mode = 'none'; stop(owned) }
})
