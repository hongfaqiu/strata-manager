import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { strataProxy } from './dev-proxy';

/**
 * KaTeX's stylesheet names every font three times (woff2, woff, ttf). Every webview the app runs in reads woff2, so the other two are
 * dropped before Vite copies the files: about 300 KB of fonts instead of 1.1 MB, all in the lazy math chunk (upstream Strata #3268).
 */
const katexWoff2Only = () => ({
  name: 'katex-woff2-only',
  enforce: 'pre' as const,
  transform(code: string, id: string) {
    if (!id.includes('katex') || !id.split('?')[0]!.endsWith('.css')) return null;
    return code.replace(/,url\([^)]*\.woff\) format\("woff"\),url\([^)]*\.ttf\) format\("truetype"\)/g, '');
  },
});

export default defineConfig({
  plugins: [katexWoff2Only(), react(), strataProxy()],
  server: { host: '127.0.0.1', port: 1427, strictPort: true },
  clearScreen: false,
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: {
    target: 'es2022',
    rollupOptions: { output: { manualChunks: { react: ['react', 'react-dom'], markdown: ['react-markdown', 'remark-gfm', 'remark-math'], query: ['@tanstack/react-query'], i18n: ['i18next', 'react-i18next'] } } },
  },
});
