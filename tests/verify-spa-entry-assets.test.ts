import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '..');
const VERIFY_SCRIPT = resolve(ROOT, 'scripts/verify-spa-entry-assets.mjs');
const TSX_CLI = resolve(ROOT, 'node_modules/tsx/dist/cli.mjs');
const BUILD_ID = '1793012345678';

function writeAssets(root: string, files: Record<string, string>): void {
  for (const [relative, source] of Object.entries(files)) {
    const target = join(root, 'dist', 'assets', relative);
    mkdirSync(resolve(target, '..'), { recursive: true });
    writeFileSync(target, source);
  }
}

function runVerifier(root: string, extraEnv: Record<string, string | undefined>): void {
  execFileSync(process.execPath, [TSX_CLI, VERIFY_SCRIPT], {
    cwd: root,
    env: { ...process.env, ...extraEnv },
    stdio: 'pipe',
  });
}

describe('verify-spa-entry-assets CDN release contract', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('allows deterministic non-CDN benchmark builds to keep a single graph', () => {
    const root = mkdtempSync(join(tmpdir(), 'verify-spa-entry-non-cdn-'));
    roots.push(root);
    writeAssets(root, {
      'index-entry.js': 'export const ready = true;',
      'index.css': 'body{color:red}',
    });

    expect(() => runVerifier(root, { DEPLOY_BUILD_ID: BUILD_ID, ASSET_CDN: undefined })).not.toThrow();
  });

  it('requires and validates the build-scoped graph for CDN builds', () => {
    const root = mkdtempSync(join(tmpdir(), 'verify-spa-entry-cdn-'));
    roots.push(root);
    writeAssets(root, {
      'index-entry.js': `/* FRONTALIERE_VERSIONED_CDN_BOOTSTRAP\n * FRONTALIERE_VERSIONED_ENTRY: https://cdn.frontaliereticino.ch/assets/releases/${BUILD_ID}/index-entry.js */`,
      [`releases/${BUILD_ID}/index-entry.js`]: 'import "./App.js";',
      [`releases/${BUILD_ID}/App.js`]: 'export const ready = true;',
      'index.css': 'body{color:red}',
    });

    expect(() => runVerifier(root, { DEPLOY_BUILD_ID: BUILD_ID, ASSET_CDN: 'https://cdn.frontaliereticino.ch' })).not.toThrow();
  });

  it('ignores legacy stable application copies but keeps stable data leaves in scope', () => {
    const root = mkdtempSync(join(tmpdir(), 'verify-spa-entry-legacy-stable-'));
    roots.push(root);
    writeAssets(root, {
      'index-entry.js': `/* FRONTALIERE_VERSIONED_CDN_BOOTSTRAP
 * FRONTALIERE_VERSIONED_ENTRY: https://cdn.frontaliereticino.ch/assets/releases/${BUILD_ID}/index-entry.js */`,
      [`releases/${BUILD_ID}/index-entry.js`]: 'import { dataReady } from "../../stable-data.js"; import "./App.js"; console.log(dataReady);',
      [`releases/${BUILD_ID}/App.js`]: 'export const ready = true;',
      'stable-data.js': 'export const dataReady = true;',
      'JobBoard.js': 'import { applyCanonicalHref } from "./index-entry.js";',
      'index.css': 'body{color:red}',
    });

    expect(() => runVerifier(root, { DEPLOY_BUILD_ID: BUILD_ID, ASSET_CDN: 'https://cdn.frontaliereticino.ch' })).not.toThrow();
  });

  it('rejects a broken named import from a stable data module', () => {
    const root = mkdtempSync(join(tmpdir(), 'verify-spa-entry-stable-data-'));
    roots.push(root);
    writeAssets(root, {
      'index-entry.js': `/* FRONTALIERE_VERSIONED_CDN_BOOTSTRAP
 * FRONTALIERE_VERSIONED_ENTRY: https://cdn.frontaliereticino.ch/assets/releases/${BUILD_ID}/index-entry.js */`,
      [`releases/${BUILD_ID}/index-entry.js`]: 'import { dataReady } from "../../stable-data.js";',
      'stable-data.js': 'export const other = true;',
      'index.css': 'body{color:red}',
    });

    expect(() => runVerifier(root, { DEPLOY_BUILD_ID: BUILD_ID, ASSET_CDN: 'https://cdn.frontaliereticino.ch' })).toThrow();
  });

  it('rejects a bootstrap whose versioned target is missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'verify-spa-entry-missing-bootstrap-target-'));
    roots.push(root);
    writeAssets(root, {
      'index-entry.js': `/* FRONTALIERE_VERSIONED_CDN_BOOTSTRAP
 * FRONTALIERE_VERSIONED_ENTRY: https://cdn.frontaliereticino.ch/assets/releases/${BUILD_ID}/missing-entry.js */`,
      [`releases/${BUILD_ID}/index-entry.js`]: 'export const ready = true;',
      'index.css': 'body{color:red}',
    });

    expect(() => runVerifier(root, { DEPLOY_BUILD_ID: BUILD_ID, ASSET_CDN: 'https://cdn.frontaliereticino.ch' })).toThrow();
  });
});
