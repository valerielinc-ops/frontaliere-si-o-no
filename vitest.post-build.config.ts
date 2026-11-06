import { defineConfig } from 'vitest/config';
import path from 'path';

/**
 * Vitest config for post-build tests that validate the dist/ output.
 * These tests run AFTER the build in the prepush pipeline.
 */
export default defineConfig({
 resolve: {
 alias: {
 '@': path.resolve(__dirname, '.'),
 },
 },
 test: {
 globals: true,
 include: ['tests/post-build/**/*.test.{ts,tsx}'],
 testTimeout: 30000,
 },
});
