import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [svelte()],
  resolve: {
    conditions: ['browser']
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**'] }
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts']
  }
});
