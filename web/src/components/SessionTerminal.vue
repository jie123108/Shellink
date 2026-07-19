<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import {
  NButton,
  NTag,
  NSpace,
  NSwitch,
  NPopconfirm,
  NModal,
  NForm,
  NFormItem,
  NInput,
  NUpload,
  NUploadDragger,
  useMessage,
  type UploadFileInfo,
} from 'naive-ui'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { api, wsUrl, downloadSessionFile, uploadSessionFile } from '../api'
import { useI18n } from 'vue-i18n'
import { useTheme } from '../theme/useTheme'

function readCssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

function terminalThemeFromCss() {
  return {
    background: readCssVar('--terminal-bg') || '#0e1613',
    foreground: readCssVar('--terminal-fg') || '#cfe3db',
    cursor: readCssVar('--terminal-cursor') || '#38d9b9',
    selectionBackground: readCssVar('--terminal-selection') || '#1f5c4f',
  }
}

const props = defineProps<{
  sessionId: string
  active: boolean
}>()

const router = useRouter()
const message = useMessage()
const { t } = useI18n()
const { themeId } = useTheme()

const termRef = ref<HTMLElement | null>(null)
const state = ref('CONNECTING')
const mode = ref<'AUTO' | 'MANUAL'>('AUTO')
const connected = ref(false)
const transferring = ref(false)

const showDownload = ref(false)
const downloadPath = ref('')
const showUpload = ref(false)
const uploadPath = ref('')
const uploadFileList = ref<UploadFileInfo[]>([])

const canTransfer = computed(
  () => state.value !== 'DISCONNECTED' && !transferring.value,
)

let term: Terminal | null = null
let fit: FitAddon | null = null
let ws: WebSocket | null = null
let resizeObserver: ResizeObserver | null = null

const stateColor: Record<string, 'default' | 'success' | 'warning' | 'error' | 'info'> = {
  CONNECTING: 'warning',
  OUTPUTTING: 'info',
  IDLE: 'warning',
  WAITING_INPUT: 'success',
  DISCONNECTED: 'default',
}

async function switchMode(manual: boolean) {
  const next = manual ? 'MANUAL' : 'AUTO'
  try {
    await api(`/sessions/${props.sessionId}/mode`, { method: 'POST', body: { mode: next } })
    mode.value = next
    term?.focus()
  } catch (e) {
    message.error((e as Error).message)
  }
}

async function closeSession() {
  try {
    await api(`/sessions/${props.sessionId}`, { method: 'DELETE' })
    message.success(t('session.closed'))
  } catch (e) {
    message.error((e as Error).message)
  }
}

function openDownload() {
  downloadPath.value = ''
  showDownload.value = true
}

function openUpload() {
  uploadPath.value = ''
  uploadFileList.value = []
  showUpload.value = true
}

function triggerDownloadBlob(data: ArrayBuffer, filename: string) {
  const blob = new Blob([new Uint8Array(data)])
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

async function doDownload() {
  const path = downloadPath.value.trim()
  if (!path) {
    message.warning(t('session.downloadRequired'))
    return
  }
  transferring.value = true
  try {
    const result = await downloadSessionFile(props.sessionId, path)
    triggerDownloadBlob(result.data, result.filename)
    message.success(t('session.downloaded', { filename: result.filename, size: result.size }))
    showDownload.value = false
  } catch (e) {
    message.error((e as Error).message)
  } finally {
    transferring.value = false
  }
}

function onUploadChange(options: { fileList: UploadFileInfo[] }) {
  uploadFileList.value = options.fileList.slice(-1)
  const file = uploadFileList.value[0]?.file
  if (file && !uploadPath.value.trim()) {
    uploadPath.value = `/tmp/${file.name}`
  }
}

async function doUpload() {
  const path = uploadPath.value.trim()
  const file = uploadFileList.value[0]?.file
  if (!path) {
    message.warning(t('session.uploadPathRequired'))
    return
  }
  if (!file) {
    message.warning(t('session.uploadFileRequired'))
    return
  }
  transferring.value = true
  try {
    const result = await uploadSessionFile(props.sessionId, path, file)
    message.success(t('session.uploaded', { path: result.remotePath, size: result.size }))
    showUpload.value = false
  } catch (e) {
    message.error((e as Error).message)
  } finally {
    transferring.value = false
  }
}

function fitIfVisible() {
  if (!termRef.value || termRef.value.offsetWidth === 0) return
  fit?.fit()
  sendResize()
}

function sendResize() {
  if (!term || !ws || ws.readyState !== WebSocket.OPEN) return
  ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
}

watch(
  () => props.active,
  async (active) => {
    if (active) {
      await nextTick()
      fitIfVisible()
      term?.focus()
    }
  },
)

watch(themeId, () => {
  if (term) {
    term.options.theme = terminalThemeFromCss()
  }
})

onMounted(() => {
  term = new Terminal({
    fontSize: 13,
    fontFamily: 'var(--font-mono), Menlo, Monaco, "Courier New", monospace',
    theme: terminalThemeFromCss(),
    scrollback: 5000,
    cursorBlink: true,
  })
  fit = new FitAddon()
  term.loadAddon(fit)
  term.loadAddon(new WebLinksAddon())
  term.open(termRef.value!)
  fitIfVisible()

  // Forward keyboard input while manually controlling the session or entering an OTP during connection.
  term.onData((data) => {
    if (mode.value === 'MANUAL' || state.value === 'CONNECTING') {
      ws?.send(JSON.stringify({ type: 'input', data }))
    }
  })

  ws = new WebSocket(wsUrl(`/sessions/${props.sessionId}`))
  ws.onopen = () => {
    connected.value = true
    sendResize()
  }
  ws.onclose = () => {
    connected.value = false
  }
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    switch (msg.type) {
      case 'replay':
      case 'data':
        term?.write(msg.data)
        break
      case 'status':
        state.value = msg.state
        mode.value = msg.mode
        break
      case 'state':
        state.value = msg.state
        break
      case 'mode':
        mode.value = msg.mode
        break
      case 'closed':
        state.value = 'DISCONNECTED'
        term?.write(`\r\n\x1b[31m${t('session.closedTerminal', { reason: msg.reason })}\x1b[0m\r\n`)
        break
    }
  }

  resizeObserver = new ResizeObserver(() => fitIfVisible())
  resizeObserver.observe(termRef.value!)
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  ws?.close()
  term?.dispose()
})
</script>

<template>
  <div class="session-pane">
    <div class="toolbar">
      <NSpace align="center">
        <NTag :type="stateColor[state] ?? 'default'" size="small">{{ state }}</NTag>
        <NTag v-if="!connected" type="error" size="small">{{ t('session.monitoringDisconnected') }}</NTag>
      </NSpace>
      <NSpace align="center">
        <span class="mode-label">{{ t('session.manualControl') }}</span>
        <NSwitch
          size="small"
          :value="mode === 'MANUAL'"
          :disabled="state === 'DISCONNECTED'"
          @update:value="switchMode"
        />
        <NButton size="tiny" :disabled="!canTransfer" :loading="transferring" @click="openDownload">
          {{ t('common.download') }}
        </NButton>
        <NButton size="tiny" :disabled="!canTransfer" :loading="transferring" @click="openUpload">
          {{ t('common.upload') }}
        </NButton>
        <NButton size="tiny" @click="router.push(`/sessions/${sessionId}/history`)">{{ t('common.history') }}</NButton>
        <NPopconfirm @positive-click="closeSession">
          <template #trigger>
            <NButton size="tiny" type="error" ghost :disabled="state === 'DISCONNECTED'">
              {{ t('session.closeSession') }}
            </NButton>
          </template>
          {{ t('session.closeConfirm') }}
        </NPopconfirm>
      </NSpace>
    </div>
    <div ref="termRef" class="terminal-wrap"></div>

    <NModal
      v-model:show="showDownload"
      preset="card"
      :title="t('session.downloadTitle')"
      style="width: 480px"
      :mask-closable="!transferring"
    >
      <NForm label-placement="top">
        <NFormItem :label="t('session.remotePath')" required>
          <NInput
            v-model:value="downloadPath"
            placeholder="/path/on/remote"
            :disabled="transferring"
            @keyup.enter="doDownload"
          />
        </NFormItem>
      </NForm>
      <template #footer>
        <NSpace justify="end">
          <NButton :disabled="transferring" @click="showDownload = false">{{ t('common.cancel') }}</NButton>
          <NButton type="primary" :loading="transferring" @click="doDownload">{{ t('common.download') }}</NButton>
        </NSpace>
      </template>
    </NModal>

    <NModal
      v-model:show="showUpload"
      preset="card"
      :title="t('session.uploadTitle')"
      style="width: 480px"
      :mask-closable="!transferring"
    >
      <NForm label-placement="top">
        <NFormItem :label="t('session.remoteTargetPath')" required>
          <NInput
            v-model:value="uploadPath"
            placeholder="/tmp/filename"
            :disabled="transferring"
          />
        </NFormItem>
        <NFormItem :label="t('session.localFile')" required>
          <NUpload
            :default-upload="false"
            :max="1"
            :file-list="uploadFileList"
            :disabled="transferring"
            @update:file-list="(list) => (uploadFileList = list.slice(-1))"
            @change="onUploadChange"
          >
            <NUploadDragger>
              <div style="padding: 12px; color: var(--text-muted)">{{ t('session.dropFile') }}</div>
            </NUploadDragger>
          </NUpload>
        </NFormItem>
      </NForm>
      <template #footer>
        <NSpace justify="end">
          <NButton :disabled="transferring" @click="showUpload = false">{{ t('common.cancel') }}</NButton>
          <NButton type="primary" :loading="transferring" @click="doUpload">{{ t('common.upload') }}</NButton>
        </NSpace>
      </template>
    </NModal>
  </div>
</template>

<style scoped>
.session-pane {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 14px;
  background: var(--terminal-panel);
  border-bottom: 1px solid var(--terminal-line);
  flex-shrink: 0;
}
.mode-label {
  font-size: 12px;
  color: var(--text-muted);
}
.terminal-wrap {
  flex: 1;
  min-height: 0;
  padding: 10px 0 6px 12px;
  background: var(--terminal-bg);
}
</style>
