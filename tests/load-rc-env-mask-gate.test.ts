import { describe, it, expect } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { scanImportClosure } from '../scripts/ci/check-dependency-free-import-closure.mjs';
import { PLAIN_WORD_RC_KEYS, RC_TO_ENV, isTrivialSecret, shouldMaskRcValue } from '../scripts/load-rc-env.mjs';

// Gate that decides whether an RC value is masked in CI logs.
// Trivial (short/common) values must NOT be masked — masking them poisons
// unrelated output, because GitHub redacts every literal occurrence. Real
// secrets must be masked.
describe('load-rc-env isTrivialSecret', () => {
  it('treats short / common values as trivial (not masked)', () => {
    for (const v of ['0', '1', '36', '12345', 'true', 'false', 'no']) {
      expect(isTrivialSecret(v), `${v} should be trivial`).toBe(true);
    }
  });

  it('treats real secrets (>= 6 chars) as non-trivial (masked)', () => {
    for (const v of [
      'AIzaSyAbcdEfGhExampleKey123', // Google API key
      're_xxxxxxxxxxxx',            // Resend key
      'ghp_aaaaaaaaaaaa',           // GitHub PAT
      'G-XXXXXXX',                  // GA measurement id
      '123456',                     // 6-digit id (e.g. long FB_PAGE_ID)
    ]) {
      expect(isTrivialSecret(v), `${v} should be masked`).toBe(false);
    }
  });

  it('treats non-string / nullish values as trivial (nothing to mask)', () => {
    expect(isTrivialSecret(null as unknown as string)).toBe(true);
    expect(isTrivialSecret(undefined as unknown as string)).toBe(true);
    expect(isTrivialSecret(42 as unknown as string)).toBe(true);
  });

  it('uses a strict length boundary at 6 chars', () => {
    expect(isTrivialSecret('abcde')).toBe(true);  // 5 chars → trivial
    expect(isTrivialSecret('abcdef')).toBe(false); // 6 chars → masked
  });
});

// The same gate with the key: a plain-word switch is never masked. "legacy" and
// "single" are six characters long, so by length alone they would be redacted
// from every later log line of the job.
describe('load-rc-env shouldMaskRcValue', () => {
  const SWITCH_WORDS = ['legacy', 'single', 'separate', 'typst', 'on', 'off'];

  it('never masks the value of a plain-word switch, whatever its length', () => {
    expect(shouldMaskRcValue('legacy', 'ASSISTED_APPLICATION_PDF_RENDERER')).toBe(false);
    expect(shouldMaskRcValue('single', 'ASSISTED_APPLICATION_DOSSIER_MODE')).toBe(false);
    for (const key of PLAIN_WORD_RC_KEYS) {
      for (const value of [...SWITCH_WORDS, 'a-much-longer-value-than-six-characters']) {
        expect(shouldMaskRcValue(value, key), `${key}=${value}`).toBe(false);
      }
    }
  });

  it('still masks the same words under any other key', () => {
    for (const key of ['RESEND_API_KEY', 'GITHUB_PAT', 'NEWSLETTER_AC_SCHEME']) {
      expect(shouldMaskRcValue('legacy', key), key).toBe(true);
      expect(shouldMaskRcValue('single', key), key).toBe(true);
      expect(shouldMaskRcValue('separate', key), key).toBe(true);
    }
  });

  it('masks a real secret', () => {
    expect(shouldMaskRcValue('re_xxxxxxxxxxxx', 'RESEND_API_KEY')).toBe(true);
    expect(shouldMaskRcValue('ghp_aaaaaaaaaaaa', 'GITHUB_PAT')).toBe(true);
  });

  it('leaves every other key of RC_TO_ENV on the length rule alone', () => {
    const others = Object.keys(RC_TO_ENV).filter((key) => !PLAIN_WORD_RC_KEYS.has(key));
    expect(others.length).toBeGreaterThan(100);
    for (const key of others) {
      for (const value of ['1', 'true', 'abcde', 'abcdef', 'legacy', 'ghp_aaaaaaaaaaaa', '', null]) {
        expect(shouldMaskRcValue(value, key), `${key}=${value}`).toBe(!isTrivialSecret(value));
      }
    }
  });

  it('exempts the three switches of the assisted application and nothing else', () => {
    expect([...PLAIN_WORD_RC_KEYS].sort()).toEqual([
      'ASSISTED_APPLICATION_DOCX_INPLACE',
      'ASSISTED_APPLICATION_DOSSIER_MODE',
      'ASSISTED_APPLICATION_PDF_RENDERER',
    ]);
  });
});

// The loader itself, as a job without `npm ci` runs it: its dependency-free
// closure copied where no node_modules exists, so firebase-admin fails to
// import and the REST path is taken, with `fetch` replaced (never the network).
describe('load-rc-env in CI: what is masked and what reaches $GITHUB_ENV', () => {
  const ROOT = path.resolve(__dirname, '..');
  const SECRET = 'invented-secret-value';
  const TEMPLATE = {
    parameters: {
      RESEND_API_KEY: { defaultValue: { value: SECRET } },
      ASSISTED_APPLICATION_PDF_RENDERER: { defaultValue: { value: 'legacy' } },
      ASSISTED_APPLICATION_DOSSIER_MODE: { defaultValue: { value: 'single' } },
      ASSISTED_APPLICATION_DOCX_INPLACE: { defaultValue: { value: 'on' } },
      // Not a switch: here the same word is still registered as a mask.
      NEWSLETTER_AC_SCHEME: { defaultValue: { value: 'legacy' } },
    },
  };

  it('writes the switches without a mask, masks the secret and the same word under another key', () => {
    // realpath: the loader runs only when argv[1] is its own URL, and macOS's tmpdir is a symlink.
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'load-rc-env-mask-'));
    try {
      for (const file of scanImportClosure({ entries: ['scripts/load-rc-env.mjs'] }).files) {
        fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
        fs.copyFileSync(path.join(ROOT, file), path.join(dir, file));
      }
      const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
      const credentials = path.join(dir, 'service-account.json');
      fs.writeFileSync(credentials, JSON.stringify({ type: 'service_account', project_id: 'frontaliere-test', client_email: 'loader@example.iam.gserviceaccount.com', private_key: privateKey }));
      const preload = path.join(dir, 'fake-google.mjs');
      fs.writeFileSync(preload, `
globalThis.fetch = async (url) => {
  if (String(url) === 'https://oauth2.googleapis.com/token') return new Response(JSON.stringify({ access_token: 'ya29.invented' }), { status: 200 });
  if (String(url) === 'https://firebaseremoteconfig.googleapis.com/v1/projects/frontaliere-test/remoteConfig') return new Response(${JSON.stringify(JSON.stringify(TEMPLATE))}, { status: 200 });
  return new Response('{}', { status: 404 });
};
`);
      const githubEnv = path.join(dir, 'github-env');
      const run = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, path.join(dir, 'scripts', 'load-rc-env.mjs')], {
        encoding: 'utf8',
        timeout: 60_000,
        // Built from scratch: a variable already set would win over the Remote Config value.
        env: { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, GITHUB_ENV: githubEnv, GOOGLE_APPLICATION_CREDENTIALS: credentials },
      });
      expect(run.status, run.stdout + run.stderr).toBe(0);
      // The premise of this test: the Admin SDK was not found, so the faked `fetch` served the template.
      expect(run.stderr).toContain('using the dependency-free REST path');

      // Sorted: the order is the order of RC_TO_ENV, which is not what is under test.
      const masks = run.stdout.split('\n').filter((line) => line.startsWith('::add-mask::')).sort();
      // "legacy" once, for NEWSLETTER_AC_SCHEME; nothing for "single".
      expect(masks).toEqual([`::add-mask::${SECRET}`, '::add-mask::legacy']);
      expect(fs.readFileSync(githubEnv, 'utf8').trim().split('\n').sort()).toEqual([
        'ASSISTED_APPLICATION_DOCX_INPLACE=on',
        'ASSISTED_APPLICATION_DOSSIER_MODE=single',
        'ASSISTED_APPLICATION_PDF_RENDERER=legacy',
        'NEWSLETTER_AC_SCHEME=legacy',
        `RESEND_API_KEY=${SECRET}`,
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
