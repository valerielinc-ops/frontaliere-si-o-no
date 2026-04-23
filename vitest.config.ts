import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
 plugins: [react()],
 resolve: {
 alias: {
 '@': path.resolve(__dirname, '.'),
 },
 },
 test: {
 globals: true,
 environment: 'jsdom',
 setupFiles: ['./tests/setup.tsx'],
 include: ['tests/**/*.test.{ts,tsx}'],
 exclude: ['tests/post-build/**', 'tests/e2e/**'],
 testTimeout: 15000,
 css: false,
 pool: 'threads',
 // Vitest 4 removed the `poolOptions` wrapper — pool tuning flags now live
 // directly on `InlineConfig`. `isolate: false` lets thread workers share a
 // single VM context, matching the previous pre-v4 behaviour.
 isolate: false,
 server: {
 deps: {
 inline: ['unpdf'],
 },
 },
 },
});
