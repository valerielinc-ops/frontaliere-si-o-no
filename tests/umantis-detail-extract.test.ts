import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { extractUmantisDetailContent, isDetailContentValid } from '../scripts/lib/umantis-listing-common.mjs';

const fixture = fs.readFileSync(
  new URL('./fixtures/gzf-umantis-detail-structures.html', import.meta.url),
  'utf8',
);
const kispiFallmanagementFixture = fs.readFileSync(
  new URL('./fixtures/kispi-umantis-fallmanagement-detail.html', import.meta.url),
  'utf8',
);
const kispiSozialpaedagogikFixture = fs.readFileSync(
  new URL('./fixtures/kispi-umantis-sozialpaedagogik-detail.html', import.meta.url),
  'utf8',
);

describe('extractUmantisDetailContent — GZF customdatablock structure', () => {
  it('preserves p-based sections and every nested bullet', () => {
    const content = extractUmantisDetailContent(fixture);

    expect(content).toContain('Ihre Aufgaben');
    expect(content).toContain('Pflege und Betreuung');
    expect(content).toContain('abgeschlossene Ausbildung');
    expect(content.match(/•/g) || []).toHaveLength(6);
    expect(content.split(/\s+/).filter(Boolean).length).toBeGreaterThan(55);
  });
});

describe('isDetailContentValid — Kispi German compound titles', () => {
  it('accepts Fallmanagement content when the body uses German compounds', () => {
    const content = extractUmantisDetailContent(kispiFallmanagementFixture);

    expect(content).toContain('Falleröffnung');
    expect(isDetailContentValid(content, 'Mitarbeiterin Fallmanagement 90% (m/w)')).toBe(true);
  });

  it('accepts Sozialpädagogin content when the body uses an inflected compound', () => {
    const content = extractUmantisDetailContent(kispiSozialpaedagogikFixture);

    expect(content).toContain('Sozialkompetenz');
    expect(isDetailContentValid(content, 'Sozialpädagogin / Sozialpädagoge in Ausbildung 60-80%')).toBe(true);
  });

  it('does not let a generic Mitarbeiter reference validate the wrong detail page', () => {
    const genericContent = `${'Mitarbeiter '.repeat(24)}Aufgaben und Profil`;

    expect(isDetailContentValid(genericContent, 'Mitarbeiterin Fallmanagement 90% (m/w)')).toBe(false);
  });
});
