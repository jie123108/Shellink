#!/usr/bin/env node
/**
 * Extract a version section from CHANGELOG.md for GitHub Releases.
 *
 * Usage:
 *   node scripts/extract-release-notes.mjs <version> [outputPath]
 *
 * Accepts "0.1.0" or "v0.1.0". Writes the matching "## [0.1.0] ..." section
 * (heading rewritten as "# Shellink 0.1.0") to the output file, or stdout
 * when outputPath is omitted.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const changelogPath = path.join(root, 'CHANGELOG.md')

const rawVersion = (process.argv[2] ?? '').trim()
const outputPath = process.argv[3]
if (!rawVersion) {
  console.error('Usage: node scripts/extract-release-notes.mjs <version> [outputPath]')
  process.exit(1)
}

const version = rawVersion.replace(/^v/i, '')
if (!/^\d+\.\d+\.\d+([.-].+)?$/.test(version)) {
  console.error(`Invalid version: ${rawVersion}`)
  process.exit(1)
}

if (!fs.existsSync(changelogPath)) {
  console.error(`Missing ${changelogPath}`)
  process.exit(1)
}

const text = fs.readFileSync(changelogPath, 'utf8')
const lines = text.split(/\r?\n/)
const headerRe = new RegExp(`^## \\[${version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\](?:\\s|$)`)

let start = -1
for (let i = 0; i < lines.length; i++) {
  if (headerRe.test(lines[i])) {
    start = i
    break
  }
}

if (start < 0) {
  console.error(
    `No "## [${version}]" section found in CHANGELOG.md.\n` +
      'Add release notes under that heading before tagging.',
  )
  process.exit(1)
}

let end = lines.length
for (let i = start + 1; i < lines.length; i++) {
  if (/^## \[/.test(lines[i])) {
    end = i
    break
  }
}

const bodyLines = lines.slice(start + 1, end)
while (bodyLines.length > 0 && bodyLines[0] === '') bodyLines.shift()
while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1] === '') bodyLines.pop()

const notes = [`# Shellink ${version}`, '', ...bodyLines, ''].join('\n')

if (outputPath) {
  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true })
  fs.writeFileSync(outputPath, notes, 'utf8')
  console.log(`Wrote release notes for ${version} to ${outputPath}`)
} else {
  process.stdout.write(notes)
}
