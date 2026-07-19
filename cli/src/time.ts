/** Format a session start timestamp as local `MM-DD hh:mm` (zero-padded). */
export function formatSessionStartedAt(createdAt: number): string {
  const date = new Date(createdAt)
  if (!Number.isFinite(createdAt) || Number.isNaN(date.getTime())) return ''
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  const hh = String(date.getHours()).padStart(2, '0')
  const min = String(date.getMinutes()).padStart(2, '0')
  return `${mm}-${dd} ${hh}:${min}`
}
