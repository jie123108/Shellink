import { defineStore } from 'pinia'

export interface TerminalTab {
  id: string
  title: string
}

/** Terminal workspace tab state, retained across routes and restored when returning. */
export const useTabsStore = defineStore('tabs', {
  state: () => ({
    tabs: [] as TerminalTab[],
    activeId: '' as string,
  }),
  actions: {
    open(id: string, title?: string) {
      const existing = this.tabs.find((t) => t.id === id)
      if (!existing) {
        this.tabs.push({ id, title: title ?? id.slice(0, 8) })
      } else if (title) {
        existing.title = title
      }
      this.activeId = id
    },
    close(id: string): string | null {
      const idx = this.tabs.findIndex((t) => t.id === id)
      if (idx === -1) return this.activeId || null
      this.tabs.splice(idx, 1)
      if (this.activeId === id) {
        const next = this.tabs[Math.min(idx, this.tabs.length - 1)]
        this.activeId = next?.id ?? ''
      }
      return this.activeId || null
    },
    setTitle(id: string, title: string) {
      const tab = this.tabs.find((t) => t.id === id)
      if (tab) tab.title = title
    },
  },
})
