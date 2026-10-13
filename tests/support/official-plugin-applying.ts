import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import type { ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { expect } from 'vitest'

const execute = promisify(execFile), packageName = '@dsh-mobile/panel-ui-verification'

/** 自有ESM入口的顶层加载等待外部HTTP；官方加载器与安装器保持原样。 */
export async function officialPluginApplying(profile: string, directory: string, run: string, automaticInstall = false) {
  const originals = new Map(await Promise.all(['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']
    .map(async file => [file, await readFile(resolve(profile, file))] as const)))
  await mkdir(directory, { recursive: true })
  await writeFile(resolve(directory, 'applying-control-baseline.json'), JSON.stringify({
    scope: 'non-credential-package-manager-files', profile,
    files: Object.fromEntries([...originals].map(([file, bytes]) => [file, bytes.toString('base64')])),
  }, null, 2) + '\n', { flag: 'wx' })
  const modes = ['finish', 'host', ...(automaticInstall ? ['controller'] as const : [])] as const
  const versions = { finish: '0.0.10', host: '0.0.11', controller: '0.0.12' }
  const names = Object.fromEntries(modes.map(mode => [mode, `@dsh-mobile/${automaticInstall ? 'auto-install' : 'activation'}-${mode}-${run.slice(0, 8)}`]))
  const requestIds = { finish: randomUUID(), host: randomUUID() }, title = 'DSHM 自动启用安装验收'
  const manifest = JSON.parse(originals.get('package.json')!.toString())
  for (const name of Object.values(names)) expect(manifest.dependencies?.[name]).toBeUndefined()
  const archives = new Map<string, Buffer>(), sockets = new Set<Socket>()
  const downloads: Array<{ mode: string; closed: boolean; bytes: number }> = []
  const loads: Array<{ mode: string; pid: number; closed: boolean; released: boolean }> = []
  const pending = new Map<string, ServerResponse>(), appliedFiles = new Map<string, Buffer>()
  let releaseNewLoads = false
  const server = createServer((request, response) => {
    const mode = modes.find(value => request.url === `/${run}/${value}.tgz`)
    if (request.method === 'GET' && mode) {
      const archive = archives.get(mode)!
      const row = { mode, closed: false, bytes: archive.length }; downloads.push(row)
      response.once('close', () => { row.closed = true })
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': archive.length }).end(archive)
      return
    }
    const load = request.url?.match(new RegExp(`^/${run}/load/(finish|host)/([1-9][0-9]*)$`))
    if (request.method !== 'GET' || !load) { response.writeHead(404).end(); return }
    const row = { mode: load[1]!, pid: Number(load[2]), closed: false, released: false }; loads.push(row)
    response.once('close', () => { row.closed = true; if (pending.get(row.mode) === response) pending.delete(row.mode) })
    if (releaseNewLoads) { row.released = true; response.writeHead(200).end('READY'); return }
    if (pending.has(row.mode)) { response.writeHead(409).end(); return }
    pending.set(row.mode, response)
  })
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(14663, '127.0.0.1', done) })
  const origin = 'http://127.0.0.1:14663'
  const snapshot = () => ({ port: 14663, downloads: downloads.map(row => ({ ...row })), loads: loads.map(row => ({ ...row })) })
  const files = ['client.js', 'index.js', 'package.json', 'README.md', 'cordis.patch.yml']
  const tar = 'C:/Windows/System32/tar.exe', old = resolve('../dsh-mobile/artifacts/official-plugin-fixtures/dsh-mobile-panel-ui-verification-0.0.5.tgz')
  const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
  try {
    expect((await execute(tar, ['-tzf', old], { windowsHide: true })).stdout.trim().split(/\r?\n/).sort())
      .toEqual(files.map(file => 'package/' + file).sort())
    for (const mode of modes) {
      const target = resolve(directory, 'official-plugin-fixtures', mode, 'package')
      await mkdir(target, { recursive: true })
      for (const file of files) {
        let text = (await execute(tar, ['-xOf', old, 'package/' + file], { windowsHide: true })).stdout
        if (file === 'package.json') {
          const manifest = JSON.parse(text)
          expect(manifest.name).toBe(packageName); expect(manifest.version).toBe('0.0.5')
          for (const key of ['scripts', 'dependencies', 'optionalDependencies']) expect(manifest[key]).toBeUndefined()
          manifest.name = names[mode]; manifest.version = versions[mode]; text = JSON.stringify(manifest, null, 2) + '\n'
        }
        if (file === 'cordis.patch.yml') text = text.replaceAll(packageName, names[mode]!)
          .replaceAll('dshm-panel-ui-verification', `dshm-activation-${mode}-${run.slice(0, 8)}`)
        if (file === 'client.js') {
          expect(text.split(packageName)).toHaveLength(3)
          text = text.replaceAll(packageName, names[mode]!)
            .replaceAll('dshm-panel-menu', `dshm-activation-menu-${mode}-${run.slice(0, 8)}`)
        }
        if (file === 'index.js') text = mode === 'controller' ? 'export function apply() {}\n'
          : `const reply = await fetch(${JSON.stringify(`${origin}/${run}/load/${mode}/`)} + process.pid, { signal: AbortSignal.timeout(120000) });\nif (reply.status !== 200) throw new Error('OWN_MODULE_NOT_RELEASED');\nawait reply.text();\nexport function apply() {}\n`
        if (file === 'client.js' && mode === 'controller') {
          // 自有可见插件面板调用原公开 Remote；不改官方目录、客户端函数或安装选项默认值。
          text = `window.__ModuleLoader__.load({ id: ${JSON.stringify(names.controller)}, factory(require) {
  const React = require('react');
  const ids = ${JSON.stringify(requestIds)}, specs = ${JSON.stringify(Object.fromEntries(['finish', 'host'].map(item => [item, `${origin}/${run}/${item}.tgz`])))};
  return { inject: ['slots', 'sidebarRightTabs', 'remote', 'remote.pluginManager'], apply(ctx) {
    const state = { finish: { phase: 'idle' }, host: { phase: 'idle' } }, listeners = new Set();
    const changed = (mode, update) => { state[mode] = { ...state[mode], ...update }; for (const fn of listeners) fn(); };
    ctx.effect(() => ctx.remote.$on('plugin-manager/install-state', value => {
      const mode = Object.keys(ids).find(item => ids[item] === value.requestId);
      if (mode) changed(mode, { phase: value.phase });
    }));
    const kind = ${JSON.stringify(`dshm-auto-install-${run.slice(0, 8)}`)};
    ctx.effect(() => ctx.sidebarRightTabs.register({ id: ${JSON.stringify(names.controller)}, kind,
      title: () => ${JSON.stringify(title)}, guide: [{ id: kind, order: 1, title: () => ${JSON.stringify(title)} }] }));
    ctx.slots.register({ name: 'sidebar.right.pane.tab', key: ${JSON.stringify(names.controller)} }, function Panel() {
      React.useSyncExternalStore(fn => { listeners.add(fn); return () => listeners.delete(fn); }, () => state.finish, () => state.finish);
      React.useSyncExternalStore(fn => { listeners.add(fn); return () => listeners.delete(fn); }, () => state.host, () => state.host);
      const install = async mode => {
        changed(mode, { phase: 'starting', started: true });
        try { changed(mode, { result: await ctx.remote.pluginManager.installBundle(specs[mode], { enabled: true, requestId: ids[mode] }) }); }
        catch (error) { changed(mode, { error: String(error.message) }); }
      };
      const cancel = async mode => {
        try { changed(mode, { cancellation: await ctx.remote.pluginManager.cancelInstall(ids[mode]) }); }
        catch (error) { changed(mode, { cancellationError: String(error.message) }); }
      };
      return React.createElement('section', { 'data-testid': 'auto-install-panel', style: { width: 360, padding: 12 } },
        React.createElement('h3', null, ${JSON.stringify(title)}), ...Object.keys(ids).map(mode =>
          React.createElement('div', { key: mode, 'data-auto-install': mode },
            React.createElement('button', { disabled: state[mode].started, onClick: () => { void install(mode); } }, '安装并启用 ' + mode),
            React.createElement('button', { disabled: !state[mode].started, onClick: () => { void cancel(mode); } }, '请求取消 ' + mode),
            React.createElement('output', { 'data-install-request': ids[mode] }, JSON.stringify(state[mode])))));
    });
  } };
} });\n`
        }
        await writeFile(resolve(target, file), text, { flag: 'wx' })
      }
      await execute(process.execPath, ['--check', resolve(target, 'index.js')], { windowsHide: true })
      await execute(process.execPath, ['--check', resolve(target, 'client.js')], { windowsHide: true })
      const path = resolve(target, `../dsh-mobile-panel-ui-verification-${versions[mode]}.tgz`)
      await execute(tar, ['-czf', path, '-C', resolve(target, '..'), 'package'], { windowsHide: true })
      archives.set(mode, await readFile(path))
    }
  } catch (error) {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>(done => server.close(() => done()))
    throw error
  }
  return {
    versions, names, requestIds, title, automaticInstall,
    specs: Object.fromEntries(modes.map(mode => [mode, `${origin}/${run}/${mode}.tgz`])),
    fixtures: modes.map(mode => ({ mode, packageName: names[mode], version: versions[mode], sourceFiles: files, noInstallScripts: true,
      sha256: createHash('sha256').update(archives.get(mode)!).digest('hex'), productsBuilt: false })),
    snapshot,
    active: () => loads.some(row => !row.closed),
    async started(mode: string) {
      await expect.poll(() => loads.some(row => row.mode === mode && !row.closed), { timeout: 30000 }).toBe(true)
      expect(loads.filter(row => row.mode === mode)).toHaveLength(1)
      const row = loads.find(row => row.mode === mode)!
      expect(alive(row.pid)).toBe(true)
      const manifest = JSON.parse(await readFile(resolve(profile, 'package.json'), 'utf8'))
      expect(manifest.dsh.profile.bundles).toContain(names[mode])
      expect(manifest.dependencies[names[mode]!]).toContain(`${run}/${mode}.tgz`)
      if (mode === 'host') for (const file of ['package.json', 'pnpm-lock.yaml']) appliedFiles.set(file, await readFile(resolve(profile, file)))
      return { ...snapshot(), officialBundleSelected: true, moduleLoadStartedInsideHost: true }
    },
    finish() {
      const response = pending.get('finish'); expect(response).toBeDefined()
      loads.find(row => row.mode === 'finish')!.released = true
      response!.writeHead(200).end('READY')
    },
    async prepareRestart() {
      const row = loads.find(row => row.mode === 'host')!
      expect(row.released).toBe(false)
      await expect.poll(() => row.closed && !alive(row.pid), { timeout: 15000 }).toBe(true)
      releaseNewLoads = true
      return { ...snapshot(), oldHostEndedBeforeRestart: true }
    },
    async settled(mode: string) {
      await expect.poll(() => loads.filter(row => row.mode === mode).every(row => row.closed), { timeout: 30000 }).toBe(true)
      expect(downloads.some(row => row.mode === mode)).toBe(true)
      expect(downloads.every(row => row.closed)).toBe(true)
      const count = downloads.filter(row => row.mode === mode).length
      await new Promise(done => setTimeout(done, 2000))
      expect(downloads.filter(row => row.mode === mode)).toHaveLength(count)
      if (mode === 'host') {
        expect(loads.filter(row => row.mode === mode)).toHaveLength(2)
        const [old, resumed] = loads.filter(row => row.mode === mode)
        expect(old!.released).toBe(false); expect(alive(old!.pid)).toBe(false)
        expect(resumed!.released).toBe(true); expect(alive(resumed!.pid)).toBe(true)
        for (const [file, bytes] of appliedFiles) expect(await readFile(resolve(profile, file))).toEqual(bytes)
      } else {
        expect(loads.filter(row => row.mode === mode)).toHaveLength(1)
        expect(loads.find(row => row.mode === mode)!.released).toBe(true)
      }
      return { ...snapshot(), noArchiveDownloadReplay: true, ...(mode === 'host' ? {
        savedInstallationUnchanged: true, normalStartupActivatedExistingBundle: true } : {}) }
    },
    async policyUnchanged() {
      expect(await readFile(resolve(profile, 'pnpm-workspace.yaml'))).toEqual(originals.get('pnpm-workspace.yaml'))
      return { scriptPolicyUnchanged: true }
    },
    async close() {
      releaseNewLoads = true
      for (const [mode, response] of pending) {
        loads.find(row => row.mode === mode && !row.closed)!.released = true
        response.writeHead(200).end('READY')
      }
      await expect.poll(() => loads.every(row => row.closed), { timeout: 15000 }).toBe(true)
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()))
    },
  }
}
