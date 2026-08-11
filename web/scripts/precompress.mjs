import { readdir, readFile, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { gzip } from 'node:zlib'
import { promisify } from 'node:util'

const gzipAsync = promisify(gzip)
const dist = new URL('../dist/', import.meta.url)
const compressible = new Set(['.css', '.html', '.js', '.json', '.svg'])
const minimumBytes = 1024

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name)
      return entry.isDirectory() ? filesUnder(path) : [path]
    }),
  )
  return files.flat()
}

const files = await filesUnder(dist.pathname)
let written = 0

await Promise.all(
  files.map(async (file) => {
    if (!compressible.has(extname(file))) return
    const source = await readFile(file)
    if (source.byteLength < minimumBytes) return
    const compressed = await gzipAsync(source, { level: 9 })
    await writeFile(`${file}.gz`, compressed)
    written += 1
  }),
)

console.log(`precompressed ${written} static assets with gzip`)
