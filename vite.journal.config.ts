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
  },
});
