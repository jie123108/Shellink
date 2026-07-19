import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const masterKey = '30616a47fe6666e88cdc2e5a8fef7d81ad6c62710d0723de5a75be2dc61fea49'

process.env.SHELLINK_MASTER_KEY ??= masterKey
process.env.SHELLINK_TOKEN ??= 'test-token'
process.env.SHELLINK_SILENCE_MS ??= '150'
process.env.SHELLINK_EXEC_TIMEOUT_MS ??= '15000'
process.env.SHELLINK_TRANSFER_TIMEOUT_MS ??= '30000'
process.env.SHELLINK_EDIT_TIMEOUT_MS ??= '30000'
process.env.SHELLINK_SSH_READY_TIMEOUT_MS ??= '3000'
process.env.SHELLINK_HOST ??= '127.0.0.1'
process.env.SHELLINK_PORT ??= '0'

if (!process.env.SHELLINK_HOME) {
  const home = path.join(os.tmpdir(), `shellink-vitest-home-${process.pid}-${Date.now()}`)
  fs.mkdirSync(home, { recursive: true, mode: 0o700 })
  process.env.SHELLINK_HOME = home
}

const dataHome = process.env.SHELLINK_HOME
process.env.SHELLINK_SOCKET ??= path.join(dataHome, 'shellink.sock')
process.env.SHELLINK_DB ??= path.join(dataHome, 'shellink.db')
