import { Pool } from 'pg'

export interface Queryable {
  query<T extends Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>
}
export interface Database extends Queryable {
  transaction<T>(work: (connection: Queryable) => Promise<T>): Promise<T>
  close(): Promise<void>
}

export function postgresDatabase(connectionString: string): Database {
  const pool = new Pool({ connectionString, max: 10, connectionTimeoutMillis: 5000, statement_timeout: 15000 })
  return {
    query: (sql, values) => pool.query(sql, values),
    async transaction(work) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const result = await work(client)
        await client.query('COMMIT')
        return result
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally { client.release() }
    },
    close: () => pool.end(),
  }
}
