import os from 'node:os'
import { config } from './config.js'

/** Reachable service addresses, including LAN IPs when bound to 0.0.0.0. */
export function serviceUrls(): string[] {
  if (config.host !== '0.0.0.0' && config.host !== '::') {
    return [`http://${config.host}:${config.port}`]
  }
  const urls = [`http://localhost:${config.port}`]
  for (const infos of Object.values(os.networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family === 'IPv4' && !info.internal) {
        urls.push(`http://${info.address}:${config.port}`)
      }
    }
  }
  return urls
}
