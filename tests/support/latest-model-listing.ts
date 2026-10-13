import { createServer } from 'node:http'
import { once } from 'node:events'

/** 隔离 HTTP 目录端点，不模拟模型执行；只核验真实发现请求及认证来源。 */
export async function latestModelListing() {
  const calls: Array<{ path: string; authentication: 'none' | 'stored' | 'temporary' | 'unexpected' }> = []
  const server = createServer((request, response) => {
    const supplied = request.headers.authorization ?? request.headers['x-api-key']
    calls.push({ path: request.url ?? '', authentication: supplied === undefined ? 'none'
      : ['Bearer synthetic-latest-stored', 'synthetic-latest-stored'].includes(String(supplied)) ? 'stored'
      : ['Bearer synthetic-latest-temporary', 'synthetic-latest-temporary'].includes(String(supplied)) ? 'temporary' : 'unexpected' })
    if (request.url?.startsWith('/redirect/')) return response.writeHead(302, { location: '/forbidden/models' }).end()
    if (request.url?.startsWith('/slow/')) return
    response.setHeader('content-type', 'application/json').end(JSON.stringify({ data: [
      { id: 'probe-discovered', display_name: 'HTTP 新模型', context_window: 128001, max_output_tokens: 4097 },
    ] }))
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw Error('listing_missing_port')
  const baseURL = `http://127.0.0.1:${address.port}/v1`
  return { baseURL, redirectURL: baseURL.replace('/v1', '/redirect/v1'), calls,
    close: async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())) } }
}
