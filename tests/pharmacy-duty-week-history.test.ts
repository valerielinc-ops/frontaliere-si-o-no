// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import recovery from '../data/pharmacy-duty-week-recovery.json';
import { buildAtomicPharmacySnapshots } from '../scripts/import-pharmacies-border.mjs';
import { readDutyWeekHistoryArchive, persistDutyWeekHistory } from '../scripts/lib/pharmacy-duty-week-history';
import { currentDutyWeekStart, DUTY_WEEK_REGIONS } from '../services/pharmacies/dutyWeek';
import { isClosedDutyWeek, isDutyWeekKey, mergeDutyWeekHistory, observeDutyWeeks, resolveDutyWeekHistory, validateDutyWeekHistory, type DutyWeekHistory } from '../services/pharmacies/dutyWeekHistory';
import { resolvePharmacySeoMetadata } from '../services/pharmacies/runtimeSeo';
import { mergeRefreshContent } from '../scripts/ci/open-data-refresh-merge.mjs';
import type { PharmacyCatalogueDataset, PharmacyDutiesDataset } from '../services/pharmacies/types';

const WEEK = currentDutyWeekStart();
const NOW = new Date(`${WEEK}T12:00:00Z`);
const iso = (hours: number) => new Date(NOW.getTime() + hours * 3600000).toISOString();
const roots: string[] = [];
const temporary = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pharmacy-week-history-')); roots.push(root); return root; };
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function pair(hours = 0) {
  const pharmacy = { id: 'test-pharmacy', name: 'Farmacia di prova', slug: 'farmacia-di-prova', city: 'Lugano', country: 'CH', canton: 'Ticino', address: 'Via Prova 1', postalCode: '6900', sourceUrl: 'https://www.ofct.ch/', sourceType: 'official', lastVerifiedAt: iso(hours) };
  return buildAtomicPharmacySnapshots({
    catalogue: { _source: 'https://www.ofct.ch/', _fetchedAt: iso(hours), pharmacies: [pharmacy], _errors: [] },
    duties: { _source: 'https://www.ofct.ch/farmacieturno/', _fetchedAt: iso(hours), _errors: [], _warnings: [], _preservedRegions: [],
      duties: DUTY_WEEK_REGIONS.map((region) => ({ id: `duty-${region.key}-${hours}`, pharmacyId: pharmacy.id, coverageType: 'region', coverageName: region.name, startsAt: iso(hours + 1), endsAt: iso(hours + 2), dutyType: 'day', status: 'verified', sourceType: 'official', sourceUrl: 'https://www.ofct.ch/', fetchedAt: iso(hours), verifiedAt: iso(hours) })) },
    evaluatedAt: iso(hours),
  }) as { catalogue: PharmacyCatalogueDataset; duties: PharmacyDutiesDataset };
}

describe('historical duty observations', () => {
  it('preserves the 24 source rows, identities, source timestamps and Git provenance', () => {
    expect(recovery.weeks.map((week) => week.weekStart)).toEqual(['2026-09-14', '2026-09-28']);
    expect(recovery.weeks.every(validateDutyWeekHistory)).toBe(true);
    for (const week of recovery.weeks) {
      const observation = week.observations[0];
      expect(observation.entries).toHaveLength(12);
      expect(new Set(observation.entries.map((entry) => entry.duty.coverageName)).size).toBe(5);
      expect(observation.sourceCommit).toMatch(/^[a-f0-9]{40}$/);
      expect(Object.values(observation.sourceBlobs).every((blob) => /^[a-f0-9]{40}$/.test(blob))).toBe(true);
      expect(observation.entries.every((entry) => entry.duty.fetchedAt === observation.fetchedAt)).toBe(true);
    }
    // Expired in the actual Sep15 source: never relabel as verified/active.
    expect(recovery.weeks[0].observations[0].entries.filter((entry) => entry.duty.status === 'expired')).toHaveLength(2);
    expect(recovery.weeks[0].observations[0].fetchedAt).toBe('2026-09-15T09:40:29.571Z');
    expect(recovery.weeks[1].observations[0].fetchedAt).toBe('2026-09-28T02:24:52.486Z');
  });

  it('captures only a healthy, hash-bound original pair without mutating it', () => {
    const source = pair();
    const original = structuredClone(source);
    const observed = observeDutyWeeks(source.catalogue, source.duties, NOW);
    expect(observed).toHaveLength(1);
    expect(observed[0].observations[0].entries).toHaveLength(5);
    expect(validateDutyWeekHistory(observed[0])).toBe(true);
    expect(source).toEqual(original);
    const tampered = structuredClone(source);
    tampered.catalogue.pharmacies[0].name = 'Unattested change';
    expect(() => observeDutyWeeks(tampered.catalogue, tampered.duties, NOW)).toThrow();
  });

  it('rejects stale, future, missing, partial and unpaired releases', () => {
    const source = pair();
    expect(() => observeDutyWeeks(source.catalogue, source.duties, new Date(iso(72)))).toThrow();
    expect(() => observeDutyWeeks(source.catalogue, source.duties, new Date(iso(-1)))).toThrow();
    for (const release of [undefined, { ...source.duties._release, state: 'partial' }, { ...source.duties._release, releaseId: 'pharmacy-v1-' + 'a'.repeat(64) }]) {
      expect(() => observeDutyWeeks(source.catalogue, { ...source.duties, _release: release } as PharmacyDutiesDataset, NOW)).toThrow();
    }
  });

  it('fails the real CLI flow for a stale valid pair without writing or reporting a successful update', { timeout: 20000 }, () => {
    const root = temporary();
    const scripts = path.join(root, 'scripts'), data = path.join(root, 'data');
    fs.mkdirSync(scripts);
    fs.mkdirSync(data);
    const source = pair(-72);
    fs.writeFileSync(path.join(data, 'pharmacies-ticino-complete.json'), JSON.stringify(source.catalogue));
    fs.writeFileSync(path.join(data, 'pharmacy-duties-ticino.json'), JSON.stringify(source.duties));
    const entrySource = fs.readFileSync(path.resolve('scripts/archive-pharmacy-duty-weeks.mts'), 'utf8');
    const dependency = "'./lib/pharmacy-duty-week-history'";
    expect(entrySource.split(dependency)).toHaveLength(2);
    // The copied CLI resolves its default root INSIDE the fixture, even before
    // the fix. Never execute the real entry point against tracked live feeds.
    const entry = path.join(scripts, 'archive-pharmacy-duty-weeks.mts');
    fs.writeFileSync(entry, entrySource.replace(dependency, JSON.stringify(pathToFileURL(path.resolve('scripts/lib/pharmacy-duty-week-history.ts')).href)));
    const result = spawnSync(process.execPath, [path.resolve('node_modules/tsx/dist/cli.mjs'), entry], { cwd: root, encoding: 'utf8', timeout: 15000 });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Cannot archive pharmacy duty weeks');
    expect(result.stdout).not.toContain('observed weekly editions updated');
    expect(fs.existsSync(path.join(data, 'pharmacy-duty-week-history'))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(data, 'pharmacy-duties-ticino.json'), 'utf8'))).toEqual(source.duties);
  });

  it('keeps interrupted temporary writes outside the refresh PR and outside the archive reader', () => {
    const temporaryPath = `data/pharmacy-duty-week-history/${WEEK}.json.123.tmp`;
    expect(execFileSync('git', ['check-ignore', '--no-index', temporaryPath], { encoding: 'utf8' }).trim()).toBe(temporaryPath);
    const root = temporary(), recoveryFile = path.join(temporary(), 'recovery.json');
    fs.writeFileSync(recoveryFile, JSON.stringify({ version: 1, weeks: [] }));
    fs.writeFileSync(path.join(root, `${WEEK}.json.123.tmp`), 'interrupted JSON');
    expect(readDutyWeekHistoryArchive(root, recoveryFile, NOW)).toEqual([]);
  });

  it('retains early assignments when a later source drops them, without duplicating refreshes', () => {
    const first = pair(), later = pair(24);
    const a = observeDutyWeeks(first.catalogue, first.duties, NOW)[0];
    const b = observeDutyWeeks(later.catalogue, later.duties, new Date(iso(24)))[0];
    const merged = mergeDutyWeekHistory(a, b);
    expect(merged.observations.flatMap((observation) => observation.entries)).toHaveLength(10);
    expect(mergeDutyWeekHistory(merged, b)).toEqual(merged);
    expect(merged.observations[0]).toEqual(a.observations[0]);
    expect(() => mergeDutyWeekHistory(a, { ...b, weekStart: 'not-a-week' })).toThrow();
  });

  it('keeps changed assignments as separate dated observations instead of overwriting history', () => {
    const source = pair();
    const a = observeDutyWeeks(source.catalogue, source.duties, NOW)[0];
    const b = structuredClone(a);
    b.observations[0].entries[0].pharmacy.name = 'Source correction';
    const merged = mergeDutyWeekHistory(a, b);
    expect(merged.observations).toHaveLength(2);
    expect(merged.observations[1].entries).toHaveLength(1);
    expect(a.observations[0].entries[0].pharmacy.name).toBe('Farmacia di prova');
  });

  it('preserves an unmerged refresh’s observations when the next data PR updates the same week', () => {
    const source = recovery.weeks[0];
    const edition = source.observations[0];
    const base = { ...source, observations: [{ ...edition, entries: [edition.entries[0]] }] };
    const pending = { ...source, observations: [...base.observations, { ...edition, entries: [edition.entries[1]] }] };
    const refresh = { ...source, observations: [...base.observations, { ...edition, entries: [edition.entries[2]] }] };
    const file = `data/pharmacy-duty-week-history/${source.weekStart}.json`;
    const merged = JSON.parse(mergeRefreshContent(file, JSON.stringify(base), JSON.stringify(pending), JSON.stringify(refresh)) as string) as DutyWeekHistory;
    expect(merged.observations).toHaveLength(3);
    expect(merged.observations.flatMap((observation) => observation.entries.map((entry) => entry.duty.id))).toEqual(edition.entries.slice(0, 3).map((entry) => entry.duty.id));
    expect(validateDutyWeekHistory(merged)).toBe(true);
    expect(() => mergeRefreshContent(file, JSON.stringify(base), JSON.stringify(pending), JSON.stringify({ ...refresh, weekStart: 'not-the-same-week' }))).toThrow();
  });

  it('publishes only closed weeks, not current/future/unknown or mismatched seeds', () => {
    const source = pair();
    const week = observeDutyWeeks(source.catalogue, source.duties, NOW)[0];
    expect(isDutyWeekKey(WEEK)).toBe(true);
    expect(isDutyWeekKey('2026-02-30')).toBe(false);
    expect(isDutyWeekKey('2026-09-15')).toBe(false);
    expect(isClosedDutyWeek(WEEK, NOW)).toBe(false);
    expect(resolveDutyWeekHistory(week, WEEK, NOW)).toBeNull();
    expect(resolveDutyWeekHistory(week, WEEK, new Date(iso(168)))).toEqual(week);
    expect(resolveDutyWeekHistory(week, '2026-09-14', new Date(iso(168)))).toBeNull();
  });

  it.each(['pharmacy', 'status', 'source', 'timestamp', 'duplicate', 'interval', 'hash'])('fails closed on invalid archived %s', (field) => {
    const week = structuredClone(recovery.weeks[0]) as DutyWeekHistory;
    const row = week.observations[0].entries[0];
    if (field === 'pharmacy') row.pharmacy.id = 'wrong';
    if (field === 'status') row.duty.status = 'conflicting';
    if (field === 'source') row.duty.sourceUrl = 'javascript:alert(1)';
    if (field === 'timestamp') row.duty.fetchedAt = '2099-01-01T00:00:00Z';
    if (field === 'duplicate') week.observations[0].entries.push(structuredClone(row));
    if (field === 'interval') row.duty.endsAt = row.duty.startsAt;
    if (field === 'hash') week.observations[0].snapshots.duties = '';
    expect(validateDutyWeekHistory(week)).toBe(false);
  });

  it('atomically persists observations only to the supplied fixture directory', () => {
    const root = temporary();
    const source = pair(), later = pair(24);
    expect(persistDutyWeekHistory(root, source.catalogue, source.duties, NOW)).toBe(1);
    expect(persistDutyWeekHistory(root, source.catalogue, source.duties, NOW)).toBe(0);
    expect(persistDutyWeekHistory(root, later.catalogue, later.duties, new Date(iso(24)))).toBe(1);
    const file = path.join(root, `${WEEK}.json`);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as DutyWeekHistory;
    expect(saved.observations.flatMap((observation) => observation.entries)).toHaveLength(10);
    expect(fs.readdirSync(root)).toEqual([`${WEEK}.json`]);
    const recoveryFile = path.join(temporary(), 'recovery.json');
    fs.writeFileSync(recoveryFile, JSON.stringify({ version: 1, weeks: [] }));
    expect(readDutyWeekHistoryArchive(root, recoveryFile, NOW)).toEqual([]);
    expect(readDutyWeekHistoryArchive(root, recoveryFile, new Date(iso(168)))).toEqual([saved]);
    fs.writeFileSync(file, '{}');
    expect(() => persistDutyWeekHistory(root, source.catalogue, source.duties, NOW)).toThrow('Invalid pharmacy duty history');
  });

  it.each(['it', 'en', 'de', 'fr'] as const)('keeps historical runtime SEO nonindexable and free of duty availability schema (%s)', (locale) => {
    const source = pair();
    // The date policy remains noindex even if a caller still has a ready model.
    const metadata = resolvePharmacySeoMetadata({ kind: 'duty-week', locale, weekStart: WEEK }, { now: new Date(iso(168)), ...source });
    expect(metadata.robots).toBe('noindex,follow');
    expect(metadata.structuredData).toBeUndefined();
  });
});
