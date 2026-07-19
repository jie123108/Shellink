import os from 'node:os'
import path from 'node:path'

export function shellinkPaths() {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0
  const home = process.env.SHELLINK_HOME
    ? path.resolve(process.env.SHELLINK_HOME)
    : path.join(os.homedir(), '.Shellink')
  const socketPath = process.env.SHELLINK_SOCKET
    ? path.resolve(process.env.SHELLINK_SOCKET)
    : process.platform === 'darwin'
      ? path.join(process.env.TMPDIR ?? os.tmpdir(), `shellink-${uid}`, 'shellink.sock')
      : process.env.XDG_RUNTIME_DIR
        ? path.join(process.env.XDG_RUNTIME_DIR, 'shellink', 'shellink.sock')
        : path.join('/tmp', `shellink-${uid}`, 'shellink.sock')
  return {
    home,
    socketPath,
    logPath: path.resolve(process.env.SHELLINK_LOG ?? path.join(home, 'shellink.log')),
    pidPath: path.join(home, 'shellink.pid'),
  }
}
