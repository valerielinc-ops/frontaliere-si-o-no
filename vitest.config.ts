import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
 plugins: [react()],
 resolve: {
 alias: {
 '@': path.resolve(__dirname, '.'),
 // `@google-cloud/recaptcha-enterprise` is only installed under
 // functions/node_modules, not at the repo root. Tests vi.mock it,
 // but Vite import-analysis runs before mocks → alias to a stub so
 // resolution succeeds and the mock can take over at module-load time.
 '@google-cloud/recaptcha-enterprise': path.resolve(__dirname, 'tests/stubs/recaptcha-enterprise.ts'),
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
