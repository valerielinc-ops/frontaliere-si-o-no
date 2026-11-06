// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createExpiredArchivePublicationEvidence } from '../build-plugins/shared/expiredArchivePublicationEvidence.mjs';
import { minifyHtml } from '../build-plugins/shared/htmlMinify';

const roots: string[] = [];
const SOURCE_SHA = 'a'.repeat(40);

function fixture({ metaDescriptionHtml = 'Descrizione SEO dell’offerta archiviata' }: {
  metaDescriptionHtml?: string;
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'expired-archive-publication-'));
  roots.push(root);
  const route = 'cerca-lavoro-ticino/late-alias/index.html';
  const file = path.join(root, route);
  const url = 'https://frontaliereticino.ch/cerca-lavoro-ticino/late-alias/';
  const titleHtml = 'Leitende Ärztin — Onkologie | Frontaliere Ticino';
  const payload = JSON.stringify({
    slug: 'late-alias',
    title: 'Leitende Ärztin — Onkologie',
    descriptionByLocale: { it: 'Descrizione originale archiviata' },
    expiredAt: '2026-10-01T00:00:00.000Z',
  });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const html = [
    '<meta charset="utf-8">',
    '<link rel="stylesheet" href="/assets/site.css">',
    '<meta name="viewport" content="width=device-width">',
    `<title>${titleHtml}</title>`,
    `<meta name="description" content="${metaDescriptionHtml}">`,
    '<meta name="robots" content="noindex,follow">',
    `<link rel="canonical" href="${url}">`,
    `<script>window.__EXPIRED_JOB_DATA__=${payload};</script>`,
    '<main data-expired-static-body="true"></main>',
  ].join('');
  fs.writeFileSync(file, minifyHtml(html));
  return { root, route, file, url, payload, titleHtml, metaDescriptionHtml };
}

function recordFixture(evidence: ReturnType<typeof createExpiredArchivePublicationEvidence>, values: ReturnType<typeof fixture>) {
  evidence.record({
    locale: 'it', path: values.route, url: values.url, payloadJson: values.payload,
    titleHtml: values.titleHtml, metaDescriptionHtml: values.metaDescriptionHtml,
    owner: { slug: 'canonical-owner', sourceIdentity: 'source:42' },
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('expired archive publication evidence', () => {
  it('attests a disk-backed alias from source owner through the emitted HTML', () => {
    const values = fixture();
    const { root, route, url } = values;
    expect(fs.readFileSync(values.file, 'utf8')).toContain('data-expired-static-body=true');
    const evidence = createExpiredArchivePublicationEvidence({ canariesPerLocale: 1 });
    recordFixture(evidence, values);

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

  it('attests the minified HTML shape emitted by the production write collector', () => {
    const values = fixture({ metaDescriptionHtml: 'A > B' });
    const { root, file } = values;
    const minifiedHtml = minifyHtml(fs.readFileSync(file, 'utf8'));
    expect(minifiedHtml).toContain('data-expired-static-body=true');
    expect(minifiedHtml).toContain('rel=canonical');
    expect(minifiedHtml).toContain('content="A > B"');
    fs.writeFileSync(file, minifiedHtml);
    const evidence = createExpiredArchivePublicationEvidence({ canariesPerLocale: 1 });
    recordFixture(evidence, values);

    const manifests = evidence.write({
      distDir: root, indexedOverflowAliases: 1, sourceRunId: '101', sourceSha: SOURCE_SHA,
    });

    expect(manifests[0].entries[0]).toMatchObject({
      evidenceKind: 'expired-archive', section: 'ticino', path: values.route, url: values.url,
    });
  });

  it('fails closed when the written payload no longer belongs to the sampled owner', () => {
    const values = fixture();
    const { root, file } = values;
    const evidence = createExpiredArchivePublicationEvidence({ canariesPerLocale: 1 });
    recordFixture(evidence, values);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('Descrizione originale', 'Descrizione sostituita'));

    expect(() => evidence.write({
      distDir: root, indexedOverflowAliases: 1, sourceRunId: '101', sourceSha: SOURCE_SHA,
    })).toThrow('payload differs from its source owner');
  });

  it.each([
    ['prefixed element', '<main-custom data-expired-static-body=true></main-custom>'],
    ['comment text', '<!-- <main data-expired-static-body=true> -->'],
    ['script text', '<script>const html = "<main data-expired-static-body=true>";</script>'],
  ])('rejects marker-like markup in %s', (_case, replacement) => {
    const values = fixture();
    const html = fs.readFileSync(values.file, 'utf8');
    const markerElement = '<main data-expired-static-body=true></main>';
    expect(html).toContain(markerElement);
    fs.writeFileSync(values.file, html.replace(markerElement, replacement));
    const evidence = createExpiredArchivePublicationEvidence({ canariesPerLocale: 1 });
    recordFixture(evidence, values);

    expect(() => evidence.write({
      distDir: values.root, indexedOverflowAliases: 1, sourceRunId: '101', sourceSha: SOURCE_SHA,
    })).toThrow('lost its static body marker');
  });

  it('fails closed when the sampled archive page is indexable', () => {
    const values = fixture();
    const evidence = createExpiredArchivePublicationEvidence({ canariesPerLocale: 1 });
    recordFixture(evidence, values);
    fs.writeFileSync(values.file, fs.readFileSync(values.file, 'utf8').replace('noindex,follow', 'index,follow'));

    expect(() => evidence.write({
      distDir: values.root, indexedOverflowAliases: 1, sourceRunId: '101', sourceSha: SOURCE_SHA,
    })).toThrow('must be noindex');
  });

  it.each([
    ['title', 'Leitende Ärztin — Onkologie | Frontaliere Ticino', 'Titolo stale'],
    ['meta description', 'Descrizione SEO dell’offerta archiviata', 'Descrizione stale'],
  ])('fails closed when the final %s differs from the rendered source', (_field, current, replacement) => {
    const values = fixture();
    const evidence = createExpiredArchivePublicationEvidence({ canariesPerLocale: 1 });
    recordFixture(evidence, values);
    fs.writeFileSync(values.file, fs.readFileSync(values.file, 'utf8').replace(current, replacement));

    expect(() => evidence.write({
      distDir: values.root, indexedOverflowAliases: 1, sourceRunId: '101', sourceSha: SOURCE_SHA,
    })).toThrow(`${_field} differs from its rendered source`);
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
