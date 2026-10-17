import { defineConfig } from 'vite';
import { version } from './package.json';
export default defineConfig({ define: { __APP_VERSION__: JSON.stringify(`v${version}`) }, build: { target: 'es2022', chunkSizeWarningLimit: 1500, rollupOptions: { input: { index: 'index.html', inventory: 'inventory/index.html' } } }, server: { host: '127.0.0.1' } });
