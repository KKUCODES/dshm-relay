import { createServer, type ServerResponse } from 'node:http'
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, relative } from 'node:path'
import { promisify } from 'node:util'
import type { Socket } from 'node:net'
import { expect } from 'vitest'

const execute = promisify(execFile), name = '@dsh-mobile/panel-ui-verification'

/** 自有安装脚本只连接本次本机控制服务；不读环境、凭据或项目文件。 */
export async function officialPluginScripts(profile: string, directory: string, run: string) {
  const files = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']
  const original = await Promise.all(files.map(file => readFile(resolve(profile, file))))
  expect(original[2]!.toString()).not.toContain('allowBuilds:')
  await mkdir(directory, { recursive: true })
  await writeFile(resolve(directory, 'script-control-baseline.json'), JSON.stringify({
    files: Object.fromEntries(files.map((file, i) => [file, original[i]!.toString('base64')])),
    profile, scope: 'non-credential-package-manager-files',
  }, null, 2) + '\n', { flag: 'wx' })
  const sockets = new Set<Socket>(), responses = new Map<string, ServerResponse>()
  const runs: Array<{ mode: string; pid: number; closed: boolean; released: boolean }> = []
  const server = createServer((request, response) => {
    const url = new URL(request.url!, 'http://localhost')
    const mode = ['cancel', 'failure', 'success'].find(mode => url.pathname === `/${run}/${mode}`)
    const pid = Number(url.searchParams.get('pid'))
    if (!mode || request.method !== 'GET' || !Number.isSafeInteger(pid) || pid <= 0) { response.writeHead(404).end(); return }
    const row = { mode, pid, closed: false, released: false }; runs.push(row); responses.set(mode, response)
    response.once('close', () => { row.closed = true; responses.delete(mode) })
  })
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const address = server.address(); if (!address || typeof address === 'string') throw Error('script_control_address_missing')
  const specs: Record<string, string> = {}, versions: Record<string, string> = {}
  const old = resolve('../dsh-mobile/artifacts/official-plugin-fixtures/dsh-mobile-panel-ui-verification-0.0.5.tgz')
  const tar = 'C:/Windows/System32/tar.exe', options = { cwd: directory, windowsHide: true }
  try {
    for (const [index, mode] of ['cancel', 'failure', 'success'].entries()) {
      const target = resolve(directory, 'official-plugin-fixtures', mode, 'package')
      await mkdir(target, { recursive: true })
      for (const file of ['client.js', 'index.js', 'package.json', 'README.md', 'cordis.patch.yml']) {
        let text = (await execute(tar, ['-xOf', old, 'package/' + file], options)).stdout
        if (file === 'package.json') {
          const manifest = JSON.parse(text); expect(manifest.name).toBe(name); expect(manifest.scripts).toBeUndefined()
          manifest.version = versions[mode] = `0.0.${7 + index}`
          manifest.scripts = { postinstall: 'node install-check.cjs' }
          text = JSON.stringify(manifest, null, 2) + '\n'
        }
        await writeFile(resolve(target, file), text, { flag: 'wx' })
      }
      const origin = `http://127.0.0.1:${address.port}/${run}/${mode}`
      await writeFile(resolve(target, 'install-check.cjs'),
        `const http = require('node:http');\nconsole.log('DSHM_OWN_SCRIPT_STARTED');\nconst request = http.get(${JSON.stringify(origin)} + '?pid=' + process.pid, response => { response.resume(); response.on('end', () => { process.exitCode = response.statusCode === 200 ? 0 : 17; }); });\nrequest.setTimeout(120000, () => request.destroy(new Error('test_script_timeout')));\nrequest.on('error', () => { process.exitCode = 18; });\n`, { flag: 'wx' })
      await execute(process.execPath, ['--check', resolve(target, 'install-check.cjs')], options)
      specs[mode] = resolve(target, `../dsh-mobile-panel-ui-verification-${versions[mode]}.tgz`)
      await execute(tar, ['-czf', specs[mode]!, '-C', resolve(target, '..'), 'package'], options)
    }
  } catch (error) { await new Promise<void>(done => server.close(() => done())); throw error }
  const snapshot = () => ({ port: address.port, requests: runs.map(row => ({ ...row })) })
  const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
  return {
    specs, versions, snapshot, active: () => runs.some(row => !row.closed),
    async blocked(mode: string, pendingName: string) {
      expect(runs.filter(row => row.mode === mode)).toHaveLength(0)
      expect(pendingName).toBe(name + '@file:' + relative(profile, specs[mode]!).replaceAll('\\', '/'))
      for (const [i, file] of files.slice(0, 2).entries()) expect(await readFile(resolve(profile, file))).toEqual(original[i])
      expect((await readFile(resolve(profile, files[2]!))).toString()).toContain(name)
      return { scriptNeverStarted: true, manifestAndLockUnchanged: true, pendingApprovalRecorded: true }
    },
    async started(mode: string) {
      await expect.poll(() => runs.some(row => row.mode === mode && !row.closed), { timeout: 60000 }).toBe(true)
      const row = runs.find(row => row.mode === mode)!; expect(alive(row.pid)).toBe(true)
      return { ...snapshot(), scriptProcessAlive: true }
    },
    finish(mode: string) {
      const response = responses.get(mode); expect(response).toBeDefined()
      runs.find(row => row.mode === mode)!.released = true
      response!.writeHead(mode === 'success' ? 200 : 503).end('DSHM_OWN_SCRIPT_COMPLETE')
    },
    async settled(mode: string) {
      await expect.poll(() => runs.filter(row => row.mode === mode).every(row => row.closed && !alive(row.pid)), { timeout: 20000 }).toBe(true)
      expect(runs.filter(row => row.mode === mode)).toHaveLength(1)
      await new Promise(done => setTimeout(done, 2000))
      expect(runs.filter(row => row.mode === mode)).toHaveLength(1)
      if (mode !== 'success') for (const [i, file] of files.slice(0, 2).entries()) expect(await readFile(resolve(profile, file))).toEqual(original[i])
      return { ...snapshot(), scriptProcessEnded: true, noAutomaticScriptReplay: true,
        ...(mode !== 'success' ? { manifestAndLockUnchanged: true } : {}) }
    },
    async restorePolicy() {
      const current = await readFile(resolve(profile, files[2]!))
      if (!current.equals(original[2]!)) {
        const base = original[2]!.toString().trimEnd()
        expect(current.toString().startsWith(base + '\nallowBuilds:\n')).toBe(true)
        const policy = current.toString().slice(base.length + '\nallowBuilds:\n'.length).trimEnd().split('\n')
        const expected = Object.values(specs).map(spec => name + '@file:' + relative(profile, spec).replaceAll('\\', '/'))
        expect(policy.length).toBeGreaterThan(0); expect(policy.length).toBeLessThanOrEqual(3)
        const keys = policy.map(line => {
          const match = /^  '([^']+)': (?:true|set this to true or false)$/.exec(line)
          expect(match).not.toBeNull(); expect(expected).toContain(match![1]); return match![1]
        })
        expect(new Set(keys).size).toBe(keys.length)
        await writeFile(resolve(profile, files[2]!), original[2]!)
      }
      expect(await readFile(resolve(profile, files[2]!))).toEqual(original[2])
      return { ownBuildApprovalRemoved: true, originalPolicyBytesRestored: true }
    },
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()))
    },
  }
}
