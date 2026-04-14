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
 server: {
 deps: {
 inline: ['unpdf'],
 },
 },
 },
});
