import { defineConfig } from 'vite'

export default defineConfig({
  preview: { host: true, port: 5173 },
  // Keep the browser app free of Creao credentials during local development.
  server: { host: true, port: 5173, proxy: { '/api': 'http://localhost:8787' } },
  build: { target: 'esnext' },
})
