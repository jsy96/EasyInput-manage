import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  resolve: {
    alias: {
      '@renderer': resolve('src/renderer/src'),
      '@shared': resolve('src/shared'),
    },
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      includeAssets: ['app-icon.svg', 'app-icon-192.png', 'app-icon-512.png'],
      manifest: {
        name: 'EasyInput Studio',
        short_name: 'EasyInput',
        description: 'EasyInput V2 开发板监控、Wi-Fi 配置与固件管理。',
        lang: 'zh-CN',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#0a111b',
        theme_color: '#0a111b',
        icons: [
          {
            src: '/app-icon-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any maskable',
          },
          {
            src: '/app-icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable',
          },
          {
            src: '/app-icon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,webmanifest}'],
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  server: { host: '127.0.0.1' },
  preview: { host: '127.0.0.1' },
})
