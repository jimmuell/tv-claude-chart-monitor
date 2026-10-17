import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  root: 'src/journal',
  build: {
    outDir: '../../dist/journal',
    emptyOutDir: true,
  },
  server: {
    port: 5174,
    strictPort: true,
    proxy: {
      // 127.0.0.1, not localhost: the journal server binds IPv4 only, while
      // `localhost` resolves to ::1 first on macOS. Using the hostname lets an
      // unrelated IPv6 listener on the same port swallow every /api call.
      // Keep the port in sync with JOURNAL_PORT in scripts/start-journal.js.
      '/api': `http://127.0.0.1:${process.env.JOURNAL_PORT || 3001}`,
    },
  },
});
