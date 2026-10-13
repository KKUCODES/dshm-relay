import type { PGlite } from '@electric-sql/pglite'
import type { Database } from '../../packages/gateway/src/database.js'

// 测试运行真正的 PostgreSQL WASM 引擎；生产始终使用 pg 连接外部 PostgreSQL。
export function pgliteDatabase(db: PGlite): Database {
  return {
    query: (sql, values) => db.query(sql, values),
    transaction: work => db.transaction(tx => work({ query: (sql, values) => tx.query(sql, values) })),
    close: () => db.close(),
  }
}
