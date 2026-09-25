/**
 * Report which stored attachments are still cited by any session log.
 *
 * Why not just delete by date: a session that is still open keeps referencing
 * today's attachments, so "delete today" breaks it — and that failure surfaces
 * as a bogus "DeepSeek API stream from api.deepseek.com failed" (TRANSPORT)
 * error, which sends you chasing the network instead of the disk.
 *
 * CRITICAL: session logs are MULTI-FRAME zstd — one frame per append. Both
 * zstdDecompressSync() and createZstdDecompress() stop after the FIRST frame,
 * which silently returns "no references at all". That result looks like
 * "everything is an orphan" and would delete attachments that live sessions
 * are still using. Every frame has to be decoded individually.
 *
 * READ-ONLY. Prints a report; deletes nothing.
 * Run: node tests/attachment_gc_report.mjs
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

// Resolve the harness home instead of hardcoding one machine's user directory:
// this file ships in a public repo, and a wrong absolute path would silently
// scan nothing (which this script would then report as "every attachment is an
// orphan").
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const SESSIONS = join(DSH_HOME, 'sessions')
const V1 = join(DSH_HOME, 'attachments', 'v1')
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** Decode every zstd frame in one session log. */
function decodeSessionLog(path) {
  const buf = readFileSync(path)
  const starts = []
  let at = buf.indexOf(ZSTD_MAGIC)
  while (at !== -1) {
    starts.push(at)
    at = buf.indexOf(ZSTD_MAGIC, at + ZSTD_MAGIC.length)
  }
  if (starts.length === 0) return buf.toString('utf8') // plain jsonl

  let text = ''
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i]
    const to = i + 1 < starts.length ? starts[i + 1] : buf.length
    try {
      text += zstdDecompressSync(buf.subarray(from, to)).toString('utf8')
    } catch {
      // The next magic may sit inside this frame's payload; retry to the end.
      try {
        text += zstdDecompressSync(buf.subarray(from)).toString('utf8')
      } catch {
        // unreadable frame — skip it rather than abort the whole scan
      }
    }
  }
  return text
}

const referenced = new Set()
let logs = 0
let frames = 0
let chars = 0

function walk(dir) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(path)
      continue
    }
    if (!/\.(zstd|jsonl)$/.test(entry.name)) continue
    try {
      const text = decodeSessionLog(path)
      chars += text.length
      logs += 1
      // attachmentId is "sha256:<64 hex>", and the stored file name is exactly
      // that hex. A loose /"attachmentId":"([^"]+)"/ also matches source text
      // the agent merely READ during the session (types.d.ts shows up in logs),
      // so anchor on the sha256: form.
      for (const match of text.matchAll(/"attachmentId"\s*:\s*"(?:sha256:)?([0-9a-f]{64})"/g)) {
        referenced.add(match[1])
      }
    } catch {
      // skip unreadable log
    }
  }
}

walk(SESSIONS)

console.log(`session logs decoded : ${logs}`)
console.log(`total chars          : ${chars.toLocaleString()}`)
console.log(`referenced attach ids: ${referenced.size}`)

function listBucket(name) {
  const dir = join(V1, name)
  const found = []
  let subdirs
  try {
    subdirs = readdirSync(dir, { withFileTypes: true })
  } catch {
    return found
  }
  for (const sub of subdirs) {
    if (!sub.isDirectory()) continue
    const inner = join(dir, sub.name)
    for (const file of readdirSync(inner)) {
      const path = join(inner, file)
      try {
        found.push({ id: file, path, size: statSync(path).size })
      } catch {
        // vanished mid-scan
      }
    }
  }
  return found
}

const mb = (bytes) => (bytes / 1048576).toFixed(1)
const total = (rows) => rows.reduce((sum, row) => sum + row.size, 0)

const objects = listBucket('objects')
const orphans = objects.filter((row) => !referenced.has(row.id))
const live = objects.length - orphans.length

console.log('')
console.log(`objects/        ${String(objects.length).padStart(4)} files  ${mb(total(objects)).padStart(6)} MB`)
console.log(`  cited by a session : ${live}`)
console.log(`  ORPHANS (removable): ${orphans.length}  ${mb(total(orphans))} MB`)

const requestImages = listBucket('request-images')
console.log(`request-images/ ${String(requestImages.length).padStart(4)} files  ${mb(total(requestImages)).padStart(6)} MB  (derived cache; rebuilt on demand)`)

const fileObjects = listBucket('file-objects')
console.log(`file-objects/   ${String(fileObjects.length).padStart(4)} files  ${mb(total(fileObjects)).padStart(6)} MB  (document uploads; not analysed here)`)

if (orphans.length > 0) {
  console.log('')
  console.log('orphan paths (unreferenced by any session log):')
  for (const row of orphans) console.log(row.path)
}
