/** Poll until predicate is true or timeout. */
export async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  opts: { timeoutMs?: number; intervalMs?: number; message?: string } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 30_000
  const intervalMs = opts.intervalMs ?? 100
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  throw new Error(opts.message ?? `waitUntil timed out after ${timeoutMs}ms`)
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
