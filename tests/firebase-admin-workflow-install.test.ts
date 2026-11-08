import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const FIREBASE_ADMIN_INSTALL =
  'npm install --prefix "$RUNNER_TEMP/firebase-admin-deps" --no-save --ignore-scripts --no-fund --no-audit firebase-admin@14.5.0';
const NODE_MODULES_LINK = 'ln -s "$RUNNER_TEMP/firebase-admin-deps/node_modules" node_modules';

const REMOTE_CONFIG_WORKFLOWS = [
  '.github/workflows/deploy-email-worker.yml',
  '.github/workflows/deploy-worker.yml',
  '.github/workflows/update-canton-tax-data.yml',
  '.github/workflows/update-fuel-prices.yml',
  '.github/workflows/update-fuel-station-inventory.yml',
  '.github/workflows/update-health-premiums.yml',
  '.github/workflows/update-pension-parameters.yml',
];

describe('Firebase Admin workflow installation', () => {
  it('keeps Remote Config-only jobs off the repository dependency tree', () => {
    for (const relativePath of REMOTE_CONFIG_WORKFLOWS) {
      const workflow = readFileSync(resolve(ROOT, relativePath), 'utf8');

      expect(workflow, relativePath).toContain(FIREBASE_ADMIN_INSTALL);
      expect(workflow, relativePath).toContain(NODE_MODULES_LINK);
      expect(workflow, relativePath).not.toMatch(/run: npm install(?: --no-save)? firebase-admin@14\.5\.0/u);
    }
  });
});
