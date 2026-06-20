import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  optimizeDeps: {
    // talkinghead.mjs는 같은 디렉터리의 lipsync-*.mjs를 상대경로로 동적 import하므로
    // Vite 사전 번들링(.vite/deps로 평탄화)을 거치면 경로가 깨진다 — 원본 그대로 서빙
    exclude: ['@met4citizen/talkinghead'],
  },
  server: { port: 5174 },
})
