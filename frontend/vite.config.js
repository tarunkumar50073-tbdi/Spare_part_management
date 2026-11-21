import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The dev server port and the API proxy target are env-configurable so a second
// (TEST) instance can run alongside production (start-test.bat did this until 14 Nov 2026): set VITE_PORT
// and VITE_API_TARGET to point the test frontend at the test backend. With no
// env set, the defaults are the usual production-dev values (5173 -> 5001).
// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // host:true binds the dev server to all network interfaces (0.0.0.0) so other
    // devices on the same WiFi/LAN can open it at http://<this-laptop-ip>:<port>.
    // Vite prints that "Network:" URL on start. (Windows Firewall must allow the port.)
    host: true,
    port: Number(process.env.VITE_PORT) || 5173,
    proxy: {
      // xfwd: the proxy adds the caller's real address to X-Forwarded-For, so
      // the backend (which believes that header only from this machine) sees
      // each LAN PC by its own address and a forged one never comes last
      // (21 Nov 2026 audit).
      '/api': { target: process.env.VITE_API_TARGET || 'http://localhost:5001', xfwd: true },
    },
  },
})
