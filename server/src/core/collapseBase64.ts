/**
 * 折叠会话展示中的超长 base64 载荷（upload/download 经 PTY 回显时）。
 * 仅用于人类可读视图；FileTransfer / RemoteEdit 解析必须用未折叠原文。
 */

const B64_RE = /[A-Za-z0-9+/=]/
const DEFAULT_HEAD = 1024
const DEFAULT_TAIL = 1024

function isB64Char(ch: string): boolean {
  return B64_RE.test(ch)
}

function isLineBreak(ch: string): boolean {
  return ch === '\n' || ch === '\r'
}

function ellipsis(omitted: number): string {
  return `....${omitted} characters omitted....`
}

/**
 * 对完整文本折叠超长 base64 段（含换行折行的 base64）。
 * 连续的 base64 字符（中间可夹杂仅由换行组成的间隔）视为同一段；
 * 段内 base64 字符数 > head+tail 时折叠。
 */
export function collapseBase64Payloads(
  text: string,
  head = DEFAULT_HEAD,
  tail = DEFAULT_TAIL,
): string {
  if (!text) return text
  const minCollapse = head + tail
  let out = ''
  let i = 0

  while (i < text.length) {
    const ch = text[i]!
    if (!isB64Char(ch)) {
      out += ch
      i++
      continue
    }

    // 收集一段：base64 字符 + 仅作为间隔的换行
    const start = i
    let b64Count = 0
    let j = i
    while (j < text.length) {
      const c = text[j]!
      if (isB64Char(c)) {
        b64Count++
        j++
        continue
      }
      if (isLineBreak(c)) {
        // 前瞻：跳过连续换行后若仍是 base64，则换行属于本段
        let k = j
        while (k < text.length && isLineBreak(text[k]!)) k++
        if (k < text.length && isB64Char(text[k]!)) {
          j = k
          continue
        }
      }
      break
    }

    const segment = text.slice(start, j)
    if (b64Count > minCollapse) {
      // 按「纯 base64 字符」取头尾，保留段内换行结构过于复杂；直接对去掉换行后的载荷取头尾再输出单行更清晰
      const compact = segment.replace(/[\r\n]+/g, '')
      const omitted = compact.length - head - tail
      out += compact.slice(0, head) + ellipsis(omitted) + compact.slice(-tail)
    } else {
      out += segment
    }
    i = j
  }

  return out
}

/**
 * 流式折叠：用于 WebSocket 实时终端。
 * 先透出前 head 个 base64 字符；中间抑制并计数；段结束时输出省略说明 + 末尾 tail。
 */
export function createBase64CollapseStream(head = DEFAULT_HEAD, tail = DEFAULT_TAIL) {
  type Mode = 'normal' | 'b64'
  let mode: Mode = 'normal'
  let headLeft = head
  /** 已见到的 base64 字符总数（不含换行） */
  let totalB64 = 0
  /** 环形保留末尾 tail 个 base64 字符（用于段结束时输出） */
  let tailRing = ''
  /** 进入抑制区后累计的被省略 base64 字符数（含仍留在 tailRing 里的） */
  let suppressed = 0
  /** b64 段内暂存的换行，若下一段不是 b64 则先结束段再吐出 */
  let pendingBreaks = ''

  function flushTailOnEnd(): string {
    if (mode !== 'b64') return ''
    let chunk = ''
    // 若从未进入抑制（全程 <= head），tailRing 里是 head 之后多出来的部分——实际上 head 路径已全部 emit
    // 抑制路径：head 已 emit，tailRing 为最后 tail 个，suppressed 含 ring 内字符
    if (suppressed > 0) {
      const omitted = Math.max(suppressed - tailRing.length, 0)
      // suppressed 统计的是 head 之后的全部；ring 是其中最后 tail 个
      // 中间省略 = suppressed - tailRing.length
      if (omitted > 0 || tailRing.length > 0) {
        // 仅当确实有被丢掉的中间部分，或需要补 tail
        const mid = suppressed - tailRing.length
        if (mid > 0) chunk += ellipsis(mid)
        chunk += tailRing
      }
    } else if (tailRing.length > 0) {
      // 总长不超过 head，tailRing 不应有内容；防御性吐出
      chunk += tailRing
    }
    chunk += pendingBreaks
    mode = 'normal'
    headLeft = head
    totalB64 = 0
    tailRing = ''
    suppressed = 0
    pendingBreaks = ''
    return chunk
  }

  function onB64Char(ch: string): string {
    let chunk = ''
    if (pendingBreaks) {
      // 换行属于 base64 块内部：抑制区时不显示中间换行，避免刷屏；头部阶段保留
      if (headLeft > 0 && suppressed === 0) {
        chunk += pendingBreaks
      }
      pendingBreaks = ''
    }
    if (mode === 'normal') {
      mode = 'b64'
      headLeft = head
      totalB64 = 0
      tailRing = ''
      suppressed = 0
    }
    totalB64++
    if (headLeft > 0) {
      headLeft--
      chunk += ch
      return chunk
    }
    // 抑制区：维护末尾 ring
    suppressed++
    tailRing += ch
    if (tailRing.length > tail) {
      tailRing = tailRing.slice(-tail)
    }
    return chunk
  }

  function push(input: string): string {
    if (!input) return ''
    let out = ''
    for (let i = 0; i < input.length; i++) {
      const ch = input[i]!
      if (isB64Char(ch)) {
        out += onB64Char(ch)
        continue
      }
      if (isLineBreak(ch) && mode === 'b64') {
        pendingBreaks += ch
        // 前瞻：若后续（跳过更多换行后）仍是 base64，则继续挂起
        let k = i + 1
        while (k < input.length && isLineBreak(input[k]!)) {
          pendingBreaks += input[k]!
          k++
        }
        if (k < input.length && isB64Char(input[k]!)) {
          i = k - 1
          continue
        }
        // 段结束
        out += flushTailOnEnd()
        continue
      }
      if (mode === 'b64') {
        out += flushTailOnEnd()
      }
      out += ch
    }
    return out
  }

  /** 连接关闭或主动结束时冲刷未完成段 */
  function flush(): string {
    return flushTailOnEnd()
  }

  return { push, flush }
}
