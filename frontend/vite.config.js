import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The dev server port and the API proxy target are env-configurable so a second
// (TEST) instance can run alongside production: start-test.bat sets VITE_PORT
// and VITE_API_TARGET to point the test frontend at the test backend. With no
// env set, the defaults are the usual production-dev values (5173 -> 5001).
// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.VITE_PORT) || 5173,
    proxy: {
      '/api': process.env.VITE_API_TARGET || 'http://localhost:5001',
    },
  },
})
