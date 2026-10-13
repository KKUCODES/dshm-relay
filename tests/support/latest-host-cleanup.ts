import { execFileSync, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { onTestFinished } from 'vitest'

/** 由测试拥有的Host进程；Vitest超时也执行回收，不依赖测试体的finally。 */
export function latestHostCleanup(hosts: Set<ChildProcess>, tree: boolean, cwd: string) {
  const stopped = new Set<ChildProcess>()
  const stop = (host: ChildProcess) => {
    if (stopped.has(host) || host.exitCode !== null || host.signalCode !== null) return
    if (tree && process.platform === 'win32') {
      try {
        execFileSync('taskkill', ['/PID', String(host.pid), '/T', '/F'], { cwd, windowsHide: true, stdio: 'ignore' })
      } catch (error) {
        // /T 可在部分进程先退出时返回失败；只接受系统确认拥有的根进程已不存在。
        // 权限错误或仍存活的根进程不能被归类为成功，调用者仍等待原 close 回调。
        try { process.kill(host.pid!, 0) }
        catch (probe) {
          if ((probe as NodeJS.ErrnoException).code === 'ESRCH') { stopped.add(host); return }
          throw probe
        }
        throw error
      }
    } else host.kill()
    // taskkill完成时Node的close回调可能尚未到达；重复钩子不再次使用该PID。
    stopped.add(host)
  }
  onTestFinished(async () => {
    for (const host of hosts) stop(host)
    // 系统命令返回并不等于 Node 已回收拥有的进程及其继承的 stdio。
    await Promise.all([...hosts].map(host => host.exitCode !== null || host.signalCode !== null
      ? Promise.resolve() : once(host, 'close')))
  })
  return stop
}
