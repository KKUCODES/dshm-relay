/** 仅压缩已由原 Host 读取的只读结果；缓存引用不是授权，也不能生成业务事件。 */
export const SYNC_CACHE_FIELD = '_dshmSync'
export const SYNC_CACHE_LIMIT = 2 * 1024 * 1024
export const syncCacheEndpoint = (endpoint: string, stream: boolean): boolean => stream
  ? ['session/follow', 'session/control', 'workspace/follow'].includes(endpoint)
  : ['session/list', 'session/page'].includes(endpoint)

export interface SyncHint { version: 1; hash?: string }
type Path = Array<string | number>
type Delta = [0, unknown] | [1, Path] | [2, Array<[string, Delta]>] | [3, Delta[]]
export interface SyncEnvelope {
  _dshmSync: 1
  hash: string
  base?: string
  value?: unknown
  delta?: Delta
}

export async function syncHash(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text)
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map(byte => byte.toString(16).padStart(2, '0')).join('')
}

/** 结构引用可复用移动后的历史记录，避免固定字节分块因新增消息整体错位。 */
export function syncDelta(value: unknown, base: unknown): Delta {
  // 完全相同的大窗口无需遍历全部节点，也不受差量拆分复杂度上限影响。
  if (JSON.stringify(value) === JSON.stringify(base)) return [1, []]
  const index = new Map<string, Path>()
  let visited = 0
  const walk = (item: unknown, path: Path): void => {
    if (++visited > 12000 || path.length > 64) throw Error('sync_cache_complexity')
    const text = JSON.stringify(item)
    if (text.length >= 96 && !index.has(text)) index.set(text, path)
    if (item && typeof item === 'object') for (const [key, child] of Object.entries(item)) {
      walk(child, [...path, Array.isArray(item) ? Number(key) : key])
    }
  }
  walk(base, [])
  visited = 0
  const encode = (item: unknown, depth: number): Delta => {
    if (++visited > 12000 || depth > 64) throw Error('sync_cache_complexity')
    const text = JSON.stringify(item), path = index.get(text)
    if (path) return [1, path]
    const literal: Delta = [0, item]
    if (!item || typeof item !== 'object' || text.length < 96) return literal
    const split: Delta = Array.isArray(item)
      ? [3, item.map(child => encode(child, depth + 1))]
      : [2, Object.entries(item).map(([key, child]): [string, Delta] => [key, encode(child, depth + 1)])]
    return JSON.stringify(split).length < JSON.stringify(literal).length ? split : literal
  }
  return encode(value, 0)
}

export function applySyncDelta(delta: Delta, base: unknown): unknown {
  let visited = 0
  const apply = (node: Delta, depth: number): unknown => {
    if (++visited > 12000 || depth > 64 || !Array.isArray(node) || node.length !== 2) throw Error('sync_cache_invalid')
    if (node[0] === 0) return node[1]
    if (node[0] === 1) {
      if (!Array.isArray(node[1]) || node[1].length > 64) throw Error('sync_cache_invalid')
      let result: unknown = base
      for (const key of node[1]) {
        if ((typeof key !== 'string' && typeof key !== 'number') || !result || typeof result !== 'object'
          || !Object.hasOwn(result, key)) throw Error('sync_cache_invalid')
        result = (result as Record<string | number, unknown>)[key]
      }
      return structuredClone(result)
    }
    if (node[0] === 3 && Array.isArray(node[1])) return node[1].map(child => apply(child, depth + 1))
    if (node[0] === 2 && Array.isArray(node[1])) {
      const result: Record<string, unknown> = {}
      for (const pair of node[1]) {
        if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || Object.hasOwn(result, pair[0])) throw Error('sync_cache_invalid')
        Object.defineProperty(result, pair[0], { value: apply(pair[1], depth + 1), enumerable: true, writable: true, configurable: true })
      }
      return result
    }
    throw Error('sync_cache_invalid')
  }
  return apply(delta, 0)
}
