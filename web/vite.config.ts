import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  base: '/shellink/ui/',
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      // 不改写 Host，便于后端按 Host + 回环地址判断本机免 token
      '/shellink/api': {
        target: 'http://localhost:7070',
        changeOrigin: false,
      },
      '/shellink/ws': {
        target: 'ws://localhost:7070',
        ws: true,
        changeOrigin: false,
      },
    },
  },
})
