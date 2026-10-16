import { describe, it, expect } from 'vitest';
import { computeSlicePartition } from '../scripts/lib/crawler-summary-partition.mjs';
import { mergePreserveLocaleData } from '../scripts/lib/dedicated-crawler-common.mjs';
import { parseVistaOstendisJob, vistaMatchKey } from '../scripts/lib/vista-job-parser.mjs';

// Only the posting's own text is published (issue 5253). A detail page without
// a body (under the shared 50-word floor) used to be replaced by a stub of metadata plus
// the company boilerplate ("{title} bei Vista. Abteilung: … Arbeitsort: …
// Vista Augenpraxen & Kliniken ist eine schweizweit tätige Gruppe …"); no job
// is built from it any more. Ostendis entry shape as served for the Vista
// tenant.
describe('parseVistaOstendisJob — vacancy text', () => {
  const entry = {
    id: 61001,
    title: 'Medizinische Praxisassistentin MPA 80-100%',
    city: 'Binningen',
    zip: '4102',
    department: 'Praxis',
    detail: 'https://link.ostendis.com/publication/mpa-binningen/abc123',
    action: 'https://link.ostendis.com/cvdropper/def456/DE?src=abc123',
  };

  it('builds the job from the detail body, without any boilerplate', () => {
    const body = 'Sie betreuen unsere Patientinnen und Patienten am Empfang und unterstützen das Ärzteteam bei Voruntersuchungen. Sie arbeiten eng mit Kolleginnen und Kollegen aus mehreren Bereichen zusammen, dokumentieren Ihre Arbeit sorgfältig und bringen Ideen zur Verbesserung der Abläufe ein. Wir bieten flexible Arbeitszeiten, Weiterbildungen und ein kollegiales Team in einem modernen Umfeld.';
    const job = parseVistaOstendisJob(entry, { description: body });
    expect(job).not.toBeNull();
    expect(job.description).toBe(body);
    expect(job.description).not.toMatch(/Vista Augenpraxen & Kliniken ist eine schweizweit/);
  });

  it('builds no job when the detail page has no vacancy text', () => {
    expect(parseVistaOstendisJob(entry, {})).toBeNull();
    expect(parseVistaOstendisJob(entry, { description: 'Kurz' })).toBeNull();
  });
});

describe('Vista source identity across Ostendis URL changes', () => {
  it('merges a renamed detail URL into one published row and one summary partition', () => {
    const entry = {
      id: 61001,
      title: 'Medizinische Praxisassistentin MPA 80-100%',
      city: 'Binningen',
      zip: '4102',
      department: 'Praxis',
      action: 'https://link.ostendis.com/cvdropper/def456/DE?src=abc123',
    };
    const body = 'Sie betreuen unsere Patientinnen und Patienten am Empfang und unterstützen das Ärzteteam bei Voruntersuchungen. Sie arbeiten eng mit Kolleginnen und Kollegen aus mehreren Bereichen zusammen, dokumentieren Ihre Arbeit sorgfältig und bringen Ideen zur Verbesserung der Abläufe ein. Wir bieten flexible Arbeitszeiten, Weiterbildungen und ein kollegiales Team in einem modernen Umfeld.';
    const previous = parseVistaOstendisJob({
      ...entry,
      detail: 'https://link.ostendis.com/publication/mpa-binningen/abc123',
    }, { description: body });
    const discovered = parseVistaOstendisJob({
      ...entry,
      detail: 'https://link.ostendis.com/publication/medizinische-praxisassistentin-binningen/xyz789',
    }, { description: body });

    expect(previous).not.toBeNull();
    expect(discovered).not.toBeNull();
    expect(discovered?.url).not.toBe(previous?.url);
    expect(discovered?.id).toBe(previous?.id);
    expect(vistaMatchKey(discovered!)).toBe(discovered?.id);

    const merged = mergePreserveLocaleData([previous!], [discovered!], {
      matchKey: vistaMatchKey,
    });
    expect(merged).toHaveLength(1);
    expect(merged[0].url).toBe(discovered?.url);

    const summary = computeSlicePartition([previous!], merged);
    expect(summary.total).toBe(1);
    expect(summary.newJobs).toHaveLength(1);
    expect(summary.unchangedJobs).toHaveLength(0);
    const newIds = new Set(summary.newJobs.map((job) => job.id));
    expect(summary.unchangedJobs.some((job) => newIds.has(job.id))).toBe(false);
  });

  it('falls back to the detail URL when a stable ID is absent', () => {
    const url = 'https://link.ostendis.com/publication/legacy/opaque-token';
    expect(vistaMatchKey({ url })).toBe(url);
    expect(vistaMatchKey({})).toBe('');
  });
});
