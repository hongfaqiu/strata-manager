import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { strataProxy } from './dev-proxy';

export default defineConfig({
  plugins: [react(), strataProxy()],
  server: { host: '127.0.0.1', port: 1427, strictPort: true },
  clearScreen: false,
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: {
    target: 'es2022',
    rollupOptions: { output: { manualChunks: { react: ['react', 'react-dom'], markdown: ['react-markdown', 'remark-gfm'], query: ['@tanstack/react-query'], i18n: ['i18next', 'react-i18next'] } } },
  },
});
