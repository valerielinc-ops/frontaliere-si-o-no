import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanImportClosure } from '../scripts/ci/check-dependency-free-import-closure.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

describe('load-rc-env server template', () => {
  it('loads private values from the Admin SDK ServerTemplate JSON data', () => {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'load-rc-env-server-template-'));
    try {
      for (const file of scanImportClosure({ entries: ['scripts/load-rc-env.mjs'] }).files) {
        fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
        fs.copyFileSync(path.join(ROOT, file), path.join(dir, file));
      }

      const firebaseAdmin = path.join(dir, 'node_modules', 'firebase-admin');
      fs.mkdirSync(firebaseAdmin, { recursive: true });
      fs.writeFileSync(path.join(firebaseAdmin, 'package.json'), JSON.stringify({
        name: 'firebase-admin',
        type: 'module',
        exports: {
          './app': './app.js',
          './remote-config': './remote-config.js',
        },
      }));
      fs.writeFileSync(path.join(firebaseAdmin, 'app.js'), `
let app;
export const applicationDefault = () => ({});
export const getApps = () => app ? [app] : [];
export const initializeApp = (options) => (app = { options });
`);
      fs.writeFileSync(path.join(firebaseAdmin, 'remote-config.js'), `
const serverData = { parameters: {
  SERVER_INSTAGRAM_ACCESS_TOKEN: { defaultValue: { value: 'private-token-fixture' } }
} };
export const getRemoteConfig = () => ({
  getTemplate: async () => ({ parameters: {} }),
  getServerTemplate: async () => ({ toJSON: () => serverData }),
});
`);

      const credentials = path.join(dir, 'service-account.json');
      fs.writeFileSync(credentials, JSON.stringify({ project_id: 'fixture-project' }));
      const githubEnv = path.join(dir, 'github-env');
      fs.writeFileSync(githubEnv, '');
      const run = spawnSync(process.execPath, [
        path.join(dir, 'scripts', 'load-rc-env.mjs'),
        '--only-env=INSTAGRAM_ACCESS_TOKEN',
        '--include-social-secrets',
      ], {
        encoding: 'utf8',
        timeout: 60_000,
        env: {
          PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
          GITHUB_ENV: githubEnv,
          GOOGLE_APPLICATION_CREDENTIALS: credentials,
        },
      });

      expect(run.status, run.stdout + run.stderr).toBe(0);
      expect(fs.readFileSync(githubEnv, 'utf8').trim()).toBe('INSTAGRAM_ACCESS_TOKEN=private-token-fixture');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
