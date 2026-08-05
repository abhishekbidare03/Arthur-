import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Port 5178 matches the address the Phase 6 launcher will open in
// `chrome --app=http://localhost:5178`, so the URL never changes.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: {
      output: {
        // Markdown parsing and syntax highlighting are ~300 kB of the bundle and
        // are only needed once an assistant message renders. Splitting them out
        // keeps the app shell chunk small. Everything is served from localhost,
        // so total size matters far less than it would over a network — this is
        // about first paint, not bandwidth.
        manualChunks: {
          markdown: ['react-markdown', 'remark-gfm', 'highlight.js/lib/common'],
        },
      },
    },
  },
  server: {
    port: 5178,
    strictPort: true,
    proxy: {
      // Same-origin `/api` in dev and in production. Keeping it same-origin
      // avoids CORS entirely, so the backend needs no cors middleware.
      '/api': {
        target: 'http://127.0.0.1:5179',
        changeOrigin: true,
        // Without this, the proxy buffers the SSE stream and tokens arrive in
        // one lump at the end — which defeats the entire point of streaming.
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes) => {
            proxyRes.headers['cache-control'] = 'no-cache, no-transform'
          })
        },
      },
    },
  },
})
