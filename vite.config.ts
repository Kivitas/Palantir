/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Dev-only proxy for the Osiris feeds under /osiris.
// Production (Cloudflare Pages) serves /osiris from functions/osiris/[[path]].ts instead.
// OSIRIS_URL is read from the shell environment at dev-server start (e.g. OSIRIS_URL=https://osiris.example.com npm run dev).
// If it is unset, nothing is proxied: /osiris requests will 404 in `vite dev`.
// To exercise the real Pages Function locally, run `npm run build` then `npm run pages:dev` (port 8788).
const osirisTarget = process.env.OSIRIS_URL?.trim()

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'jsdom',
  },
  server: {
    proxy: osirisTarget
      ? {
          '/osiris': {
            target: osirisTarget,
            changeOrigin: true,
            rewrite: (path) => path.replace(/^\/osiris/, ''),
          },
        }
      : {},
  },
})
