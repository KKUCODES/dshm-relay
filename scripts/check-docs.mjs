import { readdir, readFile, access } from 'node:fs/promises'
import { dirname, resolve, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ignored = new Set(['node_modules', 'deepseek-harness', 'dist', '.test-data', '.git', 'artifacts', 'coverage', '.tools', '.gradle', 'build'])
let count = 0, links = 0
const failures = []
async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) { await visit(path); continue }
    if (extname(path).toLowerCase() !== '.md') continue
    count++
    const text = await readFile(path, 'utf8')
    for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = match[1].replace(/^<|>$/g, '').split('#')[0]
      if (!target || /^[a-z]+:/i.test(target)) continue
      links++
      try { await access(resolve(dirname(path), decodeURIComponent(target))) }
      catch { failures.push(`${path}: ${target}`) }
    }
  }
}
await visit(fileURLToPath(new URL('../../', import.meta.url)))
if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1 }
else console.log(`Checked ${count} Markdown files and ${links} local links.`)
