import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { expandHome, readPrivateKeyFile, resolveSshPrivateKey } from '../../src/core/sshIdentity.js'

describe('sshIdentity', () => {
  it('expandHome', () => {
    expect(expandHome('~')).toBe(os.homedir())
    expect(expandHome('~/a/b')).toBe(path.join(os.homedir(), 'a/b'))
    expect(expandHome('/abs')).toBe('/abs')
  })

  it('readPrivateKeyFile returns content for PRIVATE KEY files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-key-'))
    const keyPath = path.join(dir, 'id_test')
    fs.writeFileSync(keyPath, '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n')
    expect(readPrivateKeyFile(keyPath)).toContain('PRIVATE KEY')
    fs.writeFileSync(path.join(dir, 'notkey'), 'hello')
    expect(readPrivateKeyFile(path.join(dir, 'notkey'))).toBeUndefined()
    expect(readPrivateKeyFile(path.join(dir, 'missing'))).toBeUndefined()
  })

  it('resolveSshPrivateKey uses explicit keyPath', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-key2-'))
    const keyPath = path.join(dir, 'id_ed25519')
    fs.writeFileSync(keyPath, '-----BEGIN OPENSSH PRIVATE KEY-----\nx\n-----END OPENSSH PRIVATE KEY-----\n')
    const r = resolveSshPrivateKey({ host: 'example.com', keyPath })
    expect(r?.path).toBe(path.resolve(keyPath))
    expect(r?.content).toContain('PRIVATE KEY')
  })
})
