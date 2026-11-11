import { defineConfig } from 'vite';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..'); // pet-app 根目录
const feDir = __dirname;

export default defineConfig({
  root,
  server: {
    fs: { allow: [root] },
  },
  build: {
    outDir: resolve(root, 'out'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        pet: resolve(feDir, 'pet.html'),
        dashboard: resolve(feDir, 'dashboard.html'),
        reminder: resolve(feDir, 'reminder.html'),
      },
    },
  },
});
