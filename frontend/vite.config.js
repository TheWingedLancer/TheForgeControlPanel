import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
  server: {
    port: 5173,
    proxy: {
      // For local dev: proxy /api to Functions host on 7071
      '/api': 'http://localhost:7071',
      '/.auth': 'http://localhost:4280',
    },
  },
});
