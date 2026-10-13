import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Socket } from 'node:net'
import { expect } from 'vitest'

/** 外部HTTP源只送归档前32字节；暂停真实pnpm下载，不替换任何官方函数。 */
export async function officialPluginDownload(profile: string, run: string) {
  const archive = await readFile(resolve('../dsh-mobile/artifacts/official-plugin-fixtures/dsh-mobile-panel-ui-verification-0.0.5.tgz'))
  const sockets = new Set<Socket>(), requests: Array<{ mode: string; closed: boolean; bytesSent: number }> = []
  const files = ['package.json', 'pnpm-lock.yaml']
  const bytes = async (name: string) => {
    try { return await readFile(resolve(profile, name)) }
    catch (error: any) { if (error.code === 'ENOENT') return null; throw error }
  }
  const original = await Promise.all(files.map(bytes))
  const server = createServer((request, response) => {
    const mode = ['cancel', 'host-exit'].find(value => request.url === `/${run}/${value}.tgz`)
    if (!mode || request.method !== 'GET') { response.writeHead(404).end(); return }
    const entry = { mode, closed: false, bytesSent: 32 }; requests.push(entry)
    response.once('close', () => { entry.closed = true })
    response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': archive.length })
    response.write(archive.subarray(0, 32))
  })
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const address = server.address(); if (!address || typeof address === 'string') throw Error('test_download_address_missing')
  const origin = `http://127.0.0.1:${address.port}`
  const snapshot = () => ({ port: address.port, archiveBytes: archive.length, requests: requests.map(row => ({ ...row })) })
  return {
    urls: { cancel: `${origin}/${run}/cancel.tgz`, host: `${origin}/${run}/host-exit.tgz` },
    snapshot, active: () => requests.some(row => !row.closed),
    async started(mode: string) {
      await expect.poll(() => requests.some(row => row.mode === mode && !row.closed), { timeout: 30000 }).toBe(true)
      return snapshot()
    },
    async settled(mode: string) {
      await expect.poll(() => requests.filter(row => row.mode === mode).every(row => row.closed), { timeout: 15000 }).toBe(true)
      const count = requests.filter(row => row.mode === mode).length; expect(count).toBeGreaterThan(0)
      await new Promise(done => setTimeout(done, 2000))
      expect(requests.filter(row => row.mode === mode).length).toBe(count)
      for (const [index, file] of files.entries()) expect(await bytes(file)).toEqual(original[index])
      return { ...snapshot(), noDownloadReplay: true, manifestAndLockUnchanged: true }
    },
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()))
    },
  }
}
