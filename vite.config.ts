import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@engine': fileURLToPath(new URL('./supabase/functions/_shared/engine', import.meta.url)),
    },
  },
  test: { include: ['src/__tests__/**/*.test.ts'] },
} as any);
