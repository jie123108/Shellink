import { execFileSync, execSync } from 'node:child_process'

const BASTION = 'shellink-test-bastion'
const TARGET = 'shellink-test-target'

function dockerExec(container: string, script: string): string {
  return execFileSync('docker', ['exec', container, 'sh', '-c', script], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

export function detectIface(container: string): string {
  const iface = dockerExec(
    container,
    `ip -o route show default 2>/dev/null | awk '{print $5; exit}'`,
  )
  if (!iface || iface.includes(' ')) {
    throw new Error(`Unable to detect default iface in ${container}: got "${iface}"`)
  }
  return iface
}

export interface NetemOpts {
  delayMs?: number
  lossPercent?: number
  rateKbit?: number
}

export function applyNetem(container: string, opts: NetemOpts): void {
  const iface = detectIface(container)
  const parts: string[] = []
  if (opts.delayMs != null && opts.delayMs > 0) parts.push(`delay ${opts.delayMs}ms`)
  if (opts.lossPercent != null && opts.lossPercent > 0) parts.push(`loss ${opts.lossPercent}%`)
  if (opts.rateKbit != null && opts.rateKbit > 0) parts.push(`rate ${opts.rateKbit}kbit`)
  if (parts.length === 0) throw new Error('applyNetem requires at least one impairment')
  dockerExec(container, `tc qdisc replace dev ${iface} root netem ${parts.join(' ')}`)
}

export function clearNetem(container: string): void {
  try {
    const iface = detectIface(container)
    dockerExec(container, `tc qdisc del dev ${iface} root 2>/dev/null || true`)
  } catch {
    // container may be down or iface gone
  }
}

export function clearBastionNetem(): void {
  clearNetem(BASTION)
}

export function applyBastionNetem(opts: NetemOpts): void {
  applyNetem(BASTION, opts)
}

export function waitTargetReachableFromBastion(timeoutMs = 30_000): void {
  const deadline = Date.now() + timeoutMs
  let lastErr = ''
  while (Date.now() < deadline) {
    try {
      dockerExec(BASTION, 'ping -c1 -W1 target >/dev/null 2>&1')
      return
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e)
      execSync('sleep 0.5')
    }
  }
  throw new Error(`target not reachable from bastion within ${timeoutMs}ms: ${lastErr}`)
}

/**
 * Simulate `service network restart` / sudden loss of target connectivity.
 * Drop all IPv4 on the target for `downMs`, then restore — breaks in-flight
 * SSH (docker network disconnect alone is unreliable on Docker Desktop).
 */
export function flapTargetNetwork(opts?: { downMs?: number }): void {
  const downMs = opts?.downMs ?? 5000
  dockerExec(
    TARGET,
    'iptables -I INPUT -j DROP && iptables -I OUTPUT -j DROP && iptables -I FORWARD -j DROP',
  )
  execSync(`sleep ${downMs / 1000}`)
  dockerExec(
    TARGET,
    [
      'iptables -D FORWARD -j DROP 2>/dev/null || true',
      'iptables -D OUTPUT -j DROP 2>/dev/null || true',
      'iptables -D INPUT -j DROP 2>/dev/null || true',
    ].join('; '),
  )
  waitTargetReachableFromBastion(45_000)
}

export { BASTION, TARGET }
