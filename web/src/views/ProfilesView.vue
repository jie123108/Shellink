<script setup lang="ts">
import { ref, onMounted, computed, h } from 'vue'
import { useRouter } from 'vue-router'
import {
  NButton,
  NDataTable,
  NModal,
  NForm,
  NFormItem,
  NInput,
  NInputNumber,
  NSelect,
  NSpace,
  NTag,
  NPopconfirm,
  useMessage,
} from 'naive-ui'
import type { DataTableColumns } from 'naive-ui'
import { api, type Profile } from '../api'
import { useI18n } from 'vue-i18n'

const router = useRouter()
const message = useMessage()
const { t } = useI18n()

const profiles = ref<Profile[]>([])
const searchKeyword = ref('')
const showModal = ref(false)
const editingId = ref<string | null>(null)
const saving = ref(false)

const form = ref({
  name: '',
  uniqueId: '',
  connectType: 'ssh' as 'ssh' | 'command',
  command: '',
  host: '',
  port: 22,
  username: '',
  authType: 'password' as 'password' | 'key',
  password: '',
  privateKey: '',
  passphrase: '',
  term: 'xterm-256color',
  cols: 160,
  rows: 42,
  promptRegex: '',
})

const connectTypeOptions = computed(() => [
  { label: t('profiles.ssh'), value: 'ssh' },
  { label: t('profiles.commandType'), value: 'command' },
])

const authTypeOptions = computed(() => [
  { label: t('common.password'), value: 'password' },
  { label: t('profiles.key'), value: 'key' },
])

function resetForm() {
  form.value = {
    name: '',
    uniqueId: '',
    connectType: 'ssh',
    command: '',
    host: '',
    port: 22,
    username: '',
    authType: 'password',
    password: '',
    privateKey: '',
    passphrase: '',
    term: 'xterm-256color',
    cols: 160,
    rows: 42,
    promptRegex: '',
  }
}

function openCreate() {
  editingId.value = null
  resetForm()
  showModal.value = true
}

function openEdit(p: Profile) {
  editingId.value = p.id
  form.value = {
    name: p.name,
    uniqueId: p.uniqueId ?? '',
    connectType: p.connectType ?? 'ssh',
    command: p.command ?? '',
    host: p.host,
    port: p.port,
    username: p.username,
    authType: p.authType,
    password: '',
    privateKey: '',
    passphrase: '',
    term: p.term,
    cols: p.cols,
    rows: p.rows,
    promptRegex: p.promptRegex ?? '',
  }
  showModal.value = true
}

async function save() {
  saving.value = true
  try {
    const f = form.value
    const body: Record<string, unknown> = {
      name: f.name,
      uniqueId: f.uniqueId.trim() || null,
      connectType: f.connectType,
      term: f.term,
      cols: f.cols,
      rows: f.rows,
      promptRegex: f.promptRegex || null,
    }
    if (f.connectType === 'command') {
      body.command = f.command
    } else {
      body.host = f.host
      body.port = f.port
      body.username = f.username
      body.authType = f.authType
      // Submit credentials only when supplied; an empty edit field preserves its existing value.
      if (f.password) body.password = f.password
      if (f.privateKey) body.privateKey = f.privateKey
      if (f.passphrase) body.passphrase = f.passphrase
    }

    if (editingId.value) {
      await api(`/profiles/${editingId.value}`, { method: 'PUT', body })
      message.success(t('profiles.updated'))
    } else {
      await api('/profiles', { method: 'POST', body })
      message.success(t('profiles.created'))
    }
    showModal.value = false
    await load()
  } catch (e) {
    message.error((e as Error).message)
  } finally {
    saving.value = false
  }
  return false
}

async function remove(id: string) {
  await api(`/profiles/${id}`, { method: 'DELETE' })
  message.success(t('profiles.deleted'))
  await load()
}

async function createSession(p: Profile) {
  try {
    const res = await api<{ id: string }>('/sessions', {
      method: 'POST',
      body: { profileId: p.id },
    })
    router.push(`/sessions/${res.id}`)
  } catch (e) {
    message.error((e as Error).message)
  }
}

async function load() {
  profiles.value = await api<Profile[]>('/profiles')
}

/** A profile target is user@host:port for SSH and the original command for command profiles. */
function targetOf(p: Profile): string {
  return p.connectType === 'command' ? (p.command ?? '') : `${p.username}@${p.host}:${p.port}`
}

/** Match the search keyword against both name and target without regard to case. */
const filteredProfiles = computed(() => {
  const kw = searchKeyword.value.trim().toLowerCase()
  if (!kw) return profiles.value
  return profiles.value.filter(
    (p) =>
      p.name.toLowerCase().includes(kw)
      || targetOf(p).toLowerCase().includes(kw)
      || (p.uniqueId?.toLowerCase().includes(kw) ?? false),
  )
})

const columns = computed<DataTableColumns<Profile>>(() => [
  { title: t('common.name'), key: 'name' },
  {
    title: t('common.target'),
    key: 'target',
    ellipsis: { tooltip: true },
    render: (row) => targetOf(row),
  },
  {
    title: t('common.authentication'),
    key: 'authType',
    render: (row) =>
      row.connectType === 'command'
        ? h(NTag, { size: 'small', type: 'warning' }, { default: () => t('profiles.command') })
        : h(
            NTag,
            { size: 'small' },
            { default: () => (row.authType === 'password' ? t('common.password') : t('profiles.key')) },
          ),
  },
  {
    title: t('common.actions'),
    key: 'actions',
    render: (row) =>
      h(NSpace, null, {
        default: () => [
          h(
            NButton,
            { size: 'small', type: 'primary', ghost: true, onClick: () => createSession(row) },
            { default: () => t('profiles.newSession') },
          ),
          h(NButton, { size: 'small', onClick: () => openEdit(row) }, { default: () => t('common.edit') }),
          h(
            NPopconfirm,
            { onPositiveClick: () => remove(row.id) },
            {
              trigger: () =>
                h(NButton, { size: 'small', type: 'error', ghost: true }, { default: () => t('common.delete') }),
              default: () => t('profiles.deleteConfirm'),
            },
          ),
        ],
      }),
  },
])

onMounted(load)
</script>

<template>
  <div>
    <div class="page-header">
      <div>
        <h1>{{ t('profiles.title') }}</h1>
        <div class="sub">{{ t('app.profilesSub') }}</div>
      </div>
      <NSpace align="center">
        <div class="search-wrap">
          <svg class="search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="11" cy="11" r="7" />
            <path d="M21 21l-4.3-4.3" />
          </svg>
          <NInput
            v-model:value="searchKeyword"
            :placeholder="t('profiles.filter')"
            clearable
            style="width: 260px"
          />
        </div>
        <NButton type="primary" @click="openCreate">{{ t('profiles.newProfile') }}</NButton>
      </NSpace>
    </div>

    <NDataTable :columns="columns" :data="filteredProfiles" :bordered="true" :single-line="false" />

    <NModal
      v-model:show="showModal"
      preset="card"
      :title="editingId ? t('profiles.editProfile') : t('profiles.newProfile')"
      style="width: 720px; max-height: 85vh; overflow: auto"
    >
      <NForm label-placement="left" label-width="90">
        <NFormItem :label="t('common.name')" required>
          <NInput v-model:value="form.name" :placeholder="t('profiles.namePlaceholder')" />
        </NFormItem>
        <NFormItem :label="t('profiles.uniqueId')">
          <NInput v-model:value="form.uniqueId" :placeholder="t('profiles.uniqueIdPlaceholder')" />
        </NFormItem>
        <NFormItem :label="t('common.connectionType')">
          <NSelect
            v-model:value="form.connectType"
            :options="connectTypeOptions"
            style="width: 240px"
          />
        </NFormItem>
        <template v-if="form.connectType === 'command'">
          <NFormItem :label="t('common.command')" required>
            <NInput
              v-model:value="form.command"
              :placeholder="t('profiles.commandPlaceholder')"
            />
          </NFormItem>
        </template>
        <template v-else>
          <NSpace>
            <NFormItem :label="t('common.host')" required>
              <NInput v-model:value="form.host" placeholder="jps.xunlei.cn" style="width: 240px" />
            </NFormItem>
            <NFormItem :label="t('common.port')">
              <NInputNumber v-model:value="form.port" :min="1" :max="65535" style="width: 110px" />
            </NFormItem>
            <NFormItem :label="t('common.username')" required>
              <NInput v-model:value="form.username" style="width: 150px" />
            </NFormItem>
          </NSpace>
          <NFormItem :label="t('common.authentication')">
            <NSelect
              v-model:value="form.authType"
              :options="authTypeOptions"
              style="width: 150px"
            />
          </NFormItem>
          <NFormItem v-if="form.authType === 'password'" :label="t('common.password')">
            <NInput
              v-model:value="form.password"
              type="password"
              show-password-on="click"
              :placeholder="editingId ? t('profiles.unchanged') : ''"
            />
          </NFormItem>
          <template v-else>
            <NFormItem :label="t('common.privateKey')">
              <NInput
                v-model:value="form.privateKey"
                type="textarea"
                :rows="3"
                :placeholder="editingId ? t('profiles.unchanged') : '-----BEGIN ... PRIVATE KEY-----'"
              />
            </NFormItem>
            <NFormItem :label="t('common.passphrase')">
              <NInput v-model:value="form.passphrase" type="password" show-password-on="click" />
            </NFormItem>
          </template>
        </template>
        <NSpace>
          <NFormItem :label="t('common.terminalType')">
            <NInput v-model:value="form.term" style="width: 160px" />
          </NFormItem>
          <NFormItem :label="t('common.columnsRows')">
            <NInputNumber v-model:value="form.cols" :min="20" :max="500" style="width: 100px" />
            <span style="margin: 0 6px">x</span>
            <NInputNumber v-model:value="form.rows" :min="5" :max="200" style="width: 100px" />
          </NFormItem>
        </NSpace>
        <NFormItem :label="t('profiles.promptRegex')">
          <NInput
            v-model:value="form.promptRegex"
            :placeholder="t('profiles.promptPlaceholder')"
          />
        </NFormItem>

      </NForm>

      <template #footer>
        <NSpace justify="end">
          <NButton @click="showModal = false">{{ t('common.cancel') }}</NButton>
          <NButton type="primary" :loading="saving" @click="save">{{ t('common.save') }}</NButton>
        </NSpace>
      </template>
    </NModal>

  </div>
</template>

<style scoped>
.search-wrap {
  position: relative;
  display: inline-flex;
  align-items: center;
}
.search-icon {
  position: absolute;
  left: 10px;
  z-index: 1;
  color: var(--text-muted);
  pointer-events: none;
}
.search-wrap :deep(.n-input .n-input__input-el) {
  padding-left: 30px;
}
</style>
