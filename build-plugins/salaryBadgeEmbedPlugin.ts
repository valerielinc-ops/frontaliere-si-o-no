/**
 * salaryBadgeEmbedPlugin.ts — emits `dist/embed/salary-badge-data.json` for the
 * embeddable "Stipendio medio {professione}" badge
 * (`public/embed/salary-badge.html`).
 *
 * Same self-contained pattern as the border-wait widget (PR #4506) and the
 * currency widget: a static JSON snapshot, regenerated at every build from the
 * checked-in source dataset (`data/profession-salary-medians.json`, produced by
 * `scripts/generate-profession-salary-medians.mjs`), fetched by the iframe
 * widget running on third-party sites. No runtime API, no auth, no third-party
 * script. The checked-in `public/embed/salary-badge-data.json` is the
 * pre-first-deploy fallback with the same shape.
 *
 * Plugin contract: `apply: 'build'`, `enforce: 'post'`, emit in `closeBundle()`,
 * `distDir` derived from `rootDir`. Pure/deterministic so output is stable.
 */
import type { Plugin } from 'vite';
import fs from 'node:fs';
import np from 'node:path';
import { BASE_URL } from './constants';
import {
  buildProfessionLandingPath,
  PROFESSION_IDS,
  type ProfessionId,
} from './professionLandingsData';

const PROFESSION_ID_SET: ReadonlySet<string> = new Set<string>(PROFESSION_IDS);

/** Ticino salary hub — generic follow target when a requested profession has no median. */
export const SALARY_BADGE_HUB_URL = `${BASE_URL}/stipendi-ticino/`;

/** One embeddable profession entry, with a trailing-slash follow URL to its IT landing. */
export interface SalaryBadgeProfession {
  id: string;
  label: string;
  medianChf: number;
  landingUrl: string;
}

/** Shape written to `dist/embed/salary-badge-data.json` and read by the widget. */
export interface SalaryBadgeSnapshot {
  updatedAt: string | null;
  canonicalUrl: string;
  source: string;
  professions: SalaryBadgeProfession[];
}

interface MedianPresetRaw {
  id?: unknown;
  label?: Record<string, unknown>;
  medianSalaryChf?: unknown;
}

interface MediansFileRaw {
  generatedAt?: unknown;
  source?: unknown;
  presets?: MedianPresetRaw[];
}

/**
 * Build the badge snapshot from the raw medians dataset. Pure so tests can
 * exercise it without the filesystem. Each preset with a real median AND a
 * known IT profession landing yields one entry carrying a trailing-slash
 * `landingUrl`; presets without a median or without an IT landing are dropped
 * (the widget's generic fallback covers those requests).
 */
export function buildSalaryBadgeSnapshot(raw: MediansFileRaw): SalaryBadgeSnapshot {
  const generatedAt = typeof raw.generatedAt === 'string' ? raw.generatedAt : null;
  const professions: SalaryBadgeProfession[] = [];
  for (const preset of raw.presets ?? []) {
    const id = typeof preset?.id === 'string' ? preset.id : null;
    const median =
      typeof preset?.medianSalaryChf === 'number' && Number.isFinite(preset.medianSalaryChf)
        ? preset.medianSalaryChf
        : null;
    const label =
      preset?.label && typeof preset.label.it === 'string' ? String(preset.label.it) : null;
    if (!id || median === null || !label) continue;
    if (!PROFESSION_ID_SET.has(id)) continue; // no canonical IT landing → clean fallback handles it
    professions.push({
      id,
      label,
      medianChf: Math.round(median),
      landingUrl: `${BASE_URL}${buildProfessionLandingPath('it', id as ProfessionId)}`,
    });
  }
  return {
    updatedAt: generatedAt ? generatedAt.slice(0, 10) : null,
    canonicalUrl: SALARY_BADGE_HUB_URL,
    source: typeof raw.source === 'string' ? raw.source : 'data/profession-salary-medians.json',
    professions,
  };
}

function readMediansFile(rootDir: string): MediansFileRaw {
  try {
    const p = np.join(rootDir, 'data', 'profession-salary-medians.json');
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as MediansFileRaw;
  } catch (err) {
    console.warn('[salary-badge-embed] failed to read profession-salary-medians.json', err);
    return {};
  }
}

export function salaryBadgeEmbedPlugin(rootDir: string): Plugin {
  return {
    name: 'salary-badge-embed',
    apply: 'build',
    enforce: 'post',
    closeBundle() {
      try {
        const distDir = np.resolve(rootDir, 'dist');
        const embedDir = np.join(distDir, 'embed');
        fs.mkdirSync(embedDir, { recursive: true });
        const snapshot = buildSalaryBadgeSnapshot(readMediansFile(rootDir));
        fs.writeFileSync(
          np.join(embedDir, 'salary-badge-data.json'),
          JSON.stringify(snapshot, null, 2),
          'utf-8',
        );
        // eslint-disable-next-line no-console
        console.log(
          `[salary-badge-embed] emitted salary-badge-data.json (${snapshot.professions.length} professions)`,
        );
      } catch (err) {
        console.warn('[salary-badge-embed] failed to write embed snapshot', err);
      }
    },
  };
}
