import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The Order History & P&L window is a second Vite entry. It talks to the main
// process over IPC only — there is no server and no /api proxy.
export default defineConfig({
  plugins: [react()],
  root: 'src/pnlwindow',
  build: {
    outDir: '../../dist/pnlwindow',
    emptyOutDir: true,
  },
  server: {
    port: 5175,
    strictPort: true,
  },
});
