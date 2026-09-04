import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { normalizeBasePath, pathWithinBase } from './src/shared/basePath';

const basePath = normalizeBasePath(process.env.VITE_BASE_PATH);
const serverTarget = process.env.VITE_SERVER_TARGET ?? 'http://localhost:3000';

export default defineConfig({
  base: basePath === '' ? '/' : `${basePath}/`,
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    proxy: {
      [pathWithinBase(basePath, 'socket.io')]: {
        target: serverTarget,
        ws: true,
      },
    },
  },
});
