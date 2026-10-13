import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/ws': { target: `ws://127.0.0.1:${process.env.PORT || '3000'}`, ws: true },
      '/api': { target: `http://127.0.0.1:${process.env.PORT || '3000'}` }
    }
  },
  preview: { host: '127.0.0.1' }
})
