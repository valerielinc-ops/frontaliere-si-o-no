// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createExpiredArchivePublicationEvidence } from '../build-plugins/shared/expiredArchivePublicationEvidence.mjs';

const roots: string[] = [];
const SOURCE_SHA = 'a'.repeat(40);

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'expired-archive-publication-'));
  roots.push(root);
  const route = 'cerca-lavoro-ticino/late-alias/index.html';
  const file = path.join(root, route);
  const url = 'https://frontaliereticino.ch/cerca-lavoro-ticino/late-alias/';
  const payload = JSON.stringify({
    slug: 'late-alias',
    title: 'Leitende Ärztin — Onkologie',
    descriptionByLocale: { it: 'Descrizione originale archiviata' },
    expiredAt: '2026-10-01T00:00:00.000Z',
  });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `<link rel="canonical" href="${url}"><script>window.__EXPIRED_JOB_DATA__=${payload};</script><main data-expired-static-body="true"></main>`);
  return { root, route, file, url, payload };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('expired archive publication evidence', () => {
  it('attests a disk-backed alias from source owner through the emitted HTML', () => {
    const { root, route, url, payload } = fixture();
    const evidence = createExpiredArchivePublicationEvidence({ canariesPerLocale: 1 });
    evidence.record({
      locale: 'it', path: route, url, payloadJson: payload,
      owner: { slug: 'canonical-owner', sourceIdentity: 'source:42' },
    });

    const manifests = evidence.write({
      distDir: root, indexedOverflowAliases: 201_656, sourceRunId: '101', sourceSha: SOURCE_SHA,
    });

    expect(manifests[0]).toMatchObject({
      locale: 'it', indexedOverflowAliases: 201_656, renderedOverflowPages: 1, sampleSize: 1,
    });
    expect(manifests[0].entries[0]).toMatchObject({
      evidenceKind: 'expired-archive', section: 'ticino', path: route, url,
    });
    expect(manifests[0].entries[0].ownerSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(fs.existsSync(path.join(root, 'assets', 'expired-archive-evidence-it.json'))).toBe(true);
  });

  it('fails closed when the written payload no longer belongs to the sampled owner', () => {
    const { root, route, file, url, payload } = fixture();
    const evidence = createExpiredArchivePublicationEvidence({ canariesPerLocale: 1 });
    evidence.record({ locale: 'it', path: route, url, payloadJson: payload, owner: { slug: 'owner' } });
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('Descrizione originale', 'Descrizione sostituita'));

    expect(() => evidence.write({
      distDir: root, indexedOverflowAliases: 1, sourceRunId: '101', sourceSha: SOURCE_SHA,
    })).toThrow('payload differs from its source owner');
  });

  it('requires a complete canary when overflow-backed pages were rendered', () => {
    const { root, route, url } = fixture();
    const evidence = createExpiredArchivePublicationEvidence({ canariesPerLocale: 1 });
    evidence.record({ locale: 'it', path: route, url, payloadJson: '{"slug":"missing-fields"}', owner: {} });
    expect(() => evidence.write({
      distDir: root, indexedOverflowAliases: 1, sourceRunId: '101', sourceSha: SOURCE_SHA,
    })).toThrow('no complete canary');
  });

  it('keeps build, shard publisher, and post-deploy validation on one evidence contract', () => {
    const deploy = fs.readFileSync('.github/workflows/deploy.yml', 'utf8');
    const publisher = fs.readFileSync('.github/workflows/deploy-publish.yml', 'utf8');
    const validate = fs.readFileSync('.github/workflows/post-deploy-validate-dist.yml', 'utf8');

    expect(deploy).toContain('expired-archive-evidence-${{ matrix.locale }}-${{ github.run_id }}');
    expect(deploy).toContain('--evidence-manifest "dist/assets/expired-archive-evidence-it.json"');
    expect(publisher).toContain('--evidence-manifest "$PUBLISHER_DIST/assets/expired-archive-evidence-$loc.json"');
    expect(validate).toContain('pattern: expired-archive-evidence-*-${{ inputs.deploy_run_id }}');
    expect(validate).toContain('--archive-evidence-dir "$RUNNER_TEMP/publisher-fast-gate/archive-evidence"');
  });
});
