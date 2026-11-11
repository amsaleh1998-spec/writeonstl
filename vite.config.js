import { defineConfig } from 'vite';

export default defineConfig({
  base: './', // works from any sub-path (e.g. GitHub Pages)
  optimizeDeps: { exclude: ['manifold-3d'] },
  build: { chunkSizeWarningLimit: 1500 },
});
