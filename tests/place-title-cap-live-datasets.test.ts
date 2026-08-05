/**
 * Regression coverage for issue #4828 — `audit:title-length` post-deploy failure.
 *
 * Validation run 30974294824 reported 1157 offenders over the 66-char cap and
 * tripped the per-feature rate ratchet on `spa-other`
 * (3.476 % > 1.996 % allowed, 17 offenders vs a cap of 13). Replaying the
 * auditor's own `classifyFeature` over the deployed trunk artifact attributed
 * ~49 of the ~54 full-corpus `spa-other` offenders to exactly two templates:
 *
 *   - `/guida-frontaliere/tempi-attesa-dogana/<crossing-id>/` (~44 offenders),
 *     e.g. "Traffico dogana Busingen Am Hochrhein Schaffhausen
 *     Gennersbrunnerstrasse | Tempi attesa valico" — 94 chars.
 *   - `/vivere-in-ticino/comuni-di-frontiera/<comune>/` (5 offenders),
 *     e.g. "Bardello con Malgesso e Bregano frontalieri Ticino: dogana, tasse
 *     e tempi" — 73 chars.
 *
 * Both are the #3772/#4593/#4886 class: a fixed boilerplate tuned for the
 * curated Ticino dataset, then fed unbounded place names once the surface went
 * nationwide. Both now run the shared `composePlaceTitle` cascade.
 *
 * These tests assert the property over the FULL live datasets rather than a
 * sample, so the next gazetteer/crossing expansion fails here — in `npm test`,
 * seconds — instead of in a post-deploy audit hours after the pages ship.
 */
import { describe, it, expect } from 'vitest';

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  borderCrossingLabel as labelOf,
  buildBorderCrossingTitle,
  buildBorderCrossingDescription,
} from '@/build-plugins/shared/borderCrossingTitle';
import { buildBorderMunicipalityTitle } from '@/build-plugins/borderMunicipalityPagesPlugin';
import { META_DESCRIPTION_MAX_CHARS, TITLE_MAX_CHARS } from '@/build-plugins/shared/titleSuffix';
import { ALL_BORDER_CROSSING_IDS } from '@/services/router';
import { MUNICIPALITIES } from '@/data/municipalities';

const LOCALES = ['it', 'en', 'de', 'fr'] as const;
const REPO_ROOT = resolve(__dirname, '..');
const read = (rel: string) => readFileSync(resolve(REPO_ROOT, rel), 'utf-8');

describe('border-crossing <title> stays within the audit:title-length cap (#4828)', () => {
  it('holds for every id in ALL_BORDER_CROSSING_IDS', () => {
    const offenders = (ALL_BORDER_CROSSING_IDS as readonly string[])
      .map((id) => ({ id, title: buildBorderCrossingTitle(labelOf(id)) }))
      .filter(({ title }) => title.length > TITLE_MAX_CHARS);

    expect(
      offenders,
      `over-cap crossing titles:\n${offenders
        .map((o) => `  ${o.title.length} ch  ${o.id}\n      "${o.title}"`)
        .join('\n')}`,
    ).toEqual([]);
  });

  it('never truncates the crossing label mid-place-name', () => {
    // composePlaceTitle's last-resort `truncateHeadline` appends "…". Reaching
    // it means every rung overflowed, i.e. the boilerplate is still too heavy
    // for the longest live label — a real defect, not an acceptable outcome.
    for (const id of ALL_BORDER_CROSSING_IDS as readonly string[]) {
      expect(buildBorderCrossingTitle(labelOf(id)), `crossing ${id}`).not.toContain('…');
    }
  });

  it('keeps the crossing label verbatim in the selected rung', () => {
    // The place name is the whole local-query intent; the boilerplate shrinks
    // around it, never the other way round.
    for (const id of ALL_BORDER_CROSSING_IDS as readonly string[]) {
      const label = labelOf(id);
      expect(buildBorderCrossingTitle(label), `crossing ${id}`).toContain(label);
    }
  });

  it('reproduces the pre-fix overflow: the richest rung alone would exceed the cap', () => {
    // Guards the guard — if the live dataset ever loses its long DE/FR labels
    // this suite would pass vacuously and stop protecting anything.
    const longest = (ALL_BORDER_CROSSING_IDS as readonly string[])
      .map(labelOf)
      .reduce((a, b) => (b.length > a.length ? b : a), '');
    expect(`Traffico dogana ${longest} | Tempi attesa valico`.length).toBeGreaterThan(
      TITLE_MAX_CHARS,
    );
  });
});

describe('border-crossing meta description stays within the SERP snippet budget (#4828)', () => {
  it('holds for every id in ALL_BORDER_CROSSING_IDS', () => {
    const offenders = (ALL_BORDER_CROSSING_IDS as readonly string[])
      .map((id) => ({ id, desc: buildBorderCrossingDescription(labelOf(id)) }))
      .filter(({ desc }) => desc.length > META_DESCRIPTION_MAX_CHARS);

    expect(
      offenders,
      `over-budget crossing descriptions:\n${offenders
        .map((o) => `  ${o.desc.length} ch  ${o.id}`)
        .join('\n')}`,
    ).toEqual([]);
  });

  it('reproduces the pre-fix overflow on the longest live label', () => {
    const longest = (ALL_BORDER_CROSSING_IDS as readonly string[])
      .map(labelOf)
      .reduce((a, b) => (b.length > a.length ? b : a), '');
    expect(
      `Traffico dogana ${longest} in tempo reale: tempi di attesa, orari apertura e consigli pratici per frontalieri al valico.`
        .length,
    ).toBeGreaterThan(META_DESCRIPTION_MAX_CHARS);
  });
});

/**
 * The SSG page (`staticPagesPlugin`) and the SPA runtime head (`seoService`)
 * must agree on the indexed <title>/description for the same URL. Both used to
 * carry a verbatim copy of the `Traffico dogana … | Tempi attesa valico`
 * template plus their own slug→label transform, so a cap applied to one side
 * would silently leave the other over budget. They now share one leaf module;
 * this guard is what keeps a future edit from re-forking them.
 */
describe('SSG and SPA build border-crossing metadata from the one shared module (#4828)', () => {
  for (const rel of ['build-plugins/staticPagesPlugin.ts', 'services/seoService.ts']) {
    it(`${rel} has no literal crossing title/description template left`, () => {
      const source = read(rel)
        .split('\n')
        .filter((line) => {
          const t = line.trimStart();
          return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
        })
        .join('\n');

      expect(source).toContain('buildBorderCrossingTitle');
      expect(source).toContain('buildBorderCrossingDescription');
      expect(source).not.toMatch(/`Traffico dogana \$\{label\} \| Tempi attesa valico`/);
      expect(source).not.toMatch(/`Traffico dogana \$\{label\} in tempo reale:/);
      // The slug→label transform for crossings lives in the leaf module too.
      // (Both files still title-case other tokens, so only the crossing-scoped
      // helper name is asserted here, not the generic `\b\w` transform.)
      expect(source).toContain('borderCrossingLabel(crossingId)');
    });
  }
});

describe('comune di frontiera <title> stays within the audit:title-length cap (#4828)', () => {
  it('holds for every comune × locale in the live gazetteer', () => {
    const offenders = MUNICIPALITIES.flatMap((m) =>
      LOCALES.map((locale) => ({
        name: m.name,
        locale,
        title: buildBorderMunicipalityTitle(m, locale),
      })),
    ).filter(({ title }) => title.length > TITLE_MAX_CHARS);

    expect(
      offenders,
      `over-cap comune titles:\n${offenders
        .map((o) => `  ${o.title.length} ch  [${o.locale}] ${o.name}\n      "${o.title}"`)
        .join('\n')}`,
    ).toEqual([]);
  });

  it('never degrades to a keyword-free bare comune name and never truncates it', () => {
    for (const m of MUNICIPALITIES) {
      for (const locale of LOCALES) {
        const title = buildBorderMunicipalityTitle(m, locale);
        expect(title, `${m.name} [${locale}]`).not.toBe(m.name);
        expect(title, `${m.name} [${locale}]`).not.toContain('…');
        expect(title, `${m.name} [${locale}]`).toContain(m.name);
      }
    }
  });

  it('reproduces the pre-fix overflow on the longest live comune name', () => {
    const longest = MUNICIPALITIES.map((m) => m.name).reduce(
      (a, b) => (b.length > a.length ? b : a),
      '',
    );
    expect(`${longest} frontalieri Ticino: dogana, tasse e tempi`.length).toBeGreaterThan(
      TITLE_MAX_CHARS,
    );
  });
});
