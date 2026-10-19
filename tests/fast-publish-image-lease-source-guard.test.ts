import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(resolve(__dirname, '../.github/workflows/fast-publish-article.yml'), 'utf8');
const uploaderPath = resolve(__dirname, '../scripts/lib/upload-cdn-file.sh');

describe('fast-publish image lease source guard', () => {
  it('places the protocol gate after checkout and before rendering or upload', () => {
    const checkoutAt = workflow.indexOf('- name: Checkout');
    const guardAt = workflow.indexOf('- name: Require image namespace lease protocol v1');
    const nodeSetupAt = workflow.indexOf('- name: Setup Node.js');
    const renderAt = workflow.indexOf('- name: Render article (fast path)');
    const uploadAt = workflow.indexOf('- name: Upload CDN assets (images)');

    expect(checkoutAt).toBeGreaterThanOrEqual(0);
    expect(guardAt).toBeGreaterThan(checkoutAt);
    expect(nodeSetupAt).toBeGreaterThan(guardAt);
    expect(renderAt).toBeGreaterThan(nodeSetupAt);
    expect(uploadAt).toBeGreaterThan(renderAt);
    expect(workflow.slice(guardAt, nodeSetupAt)).toContain('upload-cdn-file.sh --image-lease-protocol-version');
  });

  it('exposes protocol v1 without credentials or network access', () => {
    const version = execFileSync('bash', [uploaderPath, '--image-lease-protocol-version'], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    });
    expect(version).toBe('1\n');
  });
});
