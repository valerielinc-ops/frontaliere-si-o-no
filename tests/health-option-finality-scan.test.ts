/**
 * Observer for a CLASS of published text, not a list of files: "the LAMal/SSN
 * option is irrevocable / a one-shot choice" was copied into several generators
 * (salary landings, static pages, lead-magnet checklists, FAQ hub, German border
 * hubs) and a closed list of surfaces only ever caught some of them.
 *
 * The UFSP/BAG page (https://www.bag.admin.ch/it/assicurazione-malattie-lavoratori-frontalieri-in-svizzera)
 * states the three-month deadline and the formal exemption request to the
 * canton of employment; it does not state that the choice is irrevocable, and a
 * change of employer does not by itself reopen the option.
 *
 * Failure title: «health-option finality: scelta LAMal/SSN irrevocabile in superficie pubblicata»
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(__dirname, '..');
const ROOTS = ['build-plugins', 'components', 'data', 'services', 'hooks'] as const;
type Root = (typeof ROOTS)[number];
const EXCLUDED_DIRS = new Set(['node_modules', '__tests__', 'tests']);

const FINALITY =
  /irrevoc|irr[ée]vocable|unwiderruf|irreversib|irr[ée]versible|unumkehrbar|scelta definitiva|choix d[ée]finitif|definitive choice|una volta sola|one-shot choice|einmalige[^.]{0,20}Wahl|choix unique/i;
const HEALTH =
  /LAMal|KVG|KVV|OAMal|\bSSN\b|diritto d(?:i |'|’)opzione|droit d(?:'|’)option|Optionsrecht|option right|right of option/i;
const PROMISE =
  /cambi datore|cambiando (?:il )?datore|nuovo diritto d(?:i |'|’)opzione|change of employer|changing employer|Arbeitgeberwechsel|changement d(?:'|’)employeur/i;
/** The promise line must itself speak about the option/choice/exemption: a BVG
 *  glossary entry ("Freizügigkeit … bei Arbeitgeberwechsel") that sits next to
 *  the KVG entry is not a promise about the health option. */
const CHOICE = /opzion|option|scelt|Wahl|choi[cx]|esenzion|exemption|Befreiung|exon[ée]ration/i;
/** The option is exercised with a formal exemption request to the authority of
 *  the canton of employment, not by filing a form with the LAMal Joint
 *  Institution (Gemeinsame Einrichtung KVG). Scoped to one sentence (no `.`/`;`
 *  in between) so that the Joint Institution issuing the S1 to a LAMal-insured
 *  worker, in a different sentence from "SSN option", is not a hit. */
const JOINT_INSTITUTION =
  '(?:Istitut[oi] comune|Istituzione comune|Gemeinsamen? Einrichtung|Institution commune|Joint Institution)';
const OPTION_TERM = '(?:opzion|\\boption|Optionsrecht)';
const PROCEDURE = new RegExp(
  `${OPTION_TERM}[^.;]{0,200}${JOINT_INSTITUTION}|${JOINT_INSTITUTION}[^.;]{0,200}${OPTION_TERM}`,
  'i',
);
const WINDOW = 3;

interface ScannedFile {
  path: string;
  lines: string[];
}

interface AllowedLine {
  path: string;
  line: string;
  reason: string;
}

/** Only QUESTIONS may carry the finality word next to LAMal/SSN: an answer, a
 *  page body, a checklist or a source comment is never allowlisted, it is fixed. */
const ALLOWED: AllowedLine[] = [
  {
    path: 'services/seo/faq-translations.ts',
    line: "\"Il diritto di opzione LAMal/SSN è irreversibile?\": {",
    reason: 'chiave-domanda italiana; la risposta è stata corretta dalla PR 11207',
  },
  {
    path: 'services/seo/faq-translations.ts',
    line: 'q: "Is the LAMal/SSN right of option irreversible?"',
    reason: 'traduzione en della domanda, non un’affermazione',
  },
  {
    path: 'services/seo/faq-translations.ts',
    line: 'q: "Ist das Optionsrecht LAMal/SSN unwiderruflich?"',
    reason: 'traduzione de della domanda, non un’affermazione',
  },
  {
    path: 'services/seo/faq-translations.ts',
    line: 'q: "Le droit d\'option LAMal/SSN est-il irreversible ?"',
    reason: 'traduzione fr della domanda, non un’affermazione',
  },
];

function walk(root: Root): ScannedFile[] {
  const out: ScannedFile[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry.name)) visit(join(dir, entry.name));
        continue;
      }
      if (!entry.isFile() || !/\.tsx?$/.test(entry.name)) continue;
      const abs = join(dir, entry.name);
      out.push({
        path: relative(REPO_ROOT, abs).split(sep).join('/'),
        lines: readFileSync(abs, 'utf8').split('\n'),
      });
    }
  };
  visit(join(REPO_ROOT, root));
  return out;
}

const visitedByRoot = {} as Record<Root, number>;
const files: ScannedFile[] = [];
for (const root of ROOTS) {
  const scanned = walk(root);
  visitedByRoot[root] = scanned.length;
  files.push(...scanned);
}

function near(lines: string[], i: number, pattern: RegExp): boolean {
  for (let j = Math.max(0, i - WINDOW); j <= Math.min(lines.length - 1, i + WINDOW); j++) {
    if (pattern.test(lines[j])) return true;
  }
  return false;
}

function isAllowed(path: string, line: string): boolean {
  return ALLOWED.some((entry) => entry.path === path && line.includes(entry.line));
}

describe('health option finality scan', () => {
  it('no unconditional LAMal/SSN finality on any source surface', () => {
    const violations: string[] = [];
    for (const { path, lines } of files) {
      lines.forEach((line, i) => {
        if (isAllowed(path, line)) return;
        if (FINALITY.test(line) && near(lines, i, HEALTH)) {
          violations.push(`${path}:${i + 1} [finality] ${line.trim().slice(0, 140)}`);
        }
        if (PROMISE.test(line) && CHOICE.test(line) && near(lines, i, HEALTH)) {
          violations.push(`${path}:${i + 1} [employer-change promise] ${line.trim().slice(0, 140)}`);
        }
        if (PROCEDURE.test(line)) {
          violations.push(`${path}:${i + 1} [joint-institution procedure] ${line.trim().slice(0, 140)}`);
        }
      });
    }
    expect(
      violations,
      `health-option finality: scelta LAMal/SSN irrevocabile in superficie pubblicata (${violations.length})\n${violations.join('\n')}`,
    ).toEqual([]);
  });

  it('allowlist has no dead entries', () => {
    const byPath = new Map(files.map((file) => [file.path, file.lines]));
    const dead = ALLOWED.filter((entry) => {
      expect(entry.reason.trim().length).toBeGreaterThan(0);
      return !(byPath.get(entry.path) ?? []).some((line) => line.includes(entry.line));
    }).map((entry) => `${entry.path}: ${entry.line}`);
    expect(dead).toEqual([]);
  });

  it('walker covers every root', () => {
    for (const root of ROOTS) {
      expect(visitedByRoot[root], `no .ts/.tsx visited under ${root}`).toBeGreaterThan(0);
    }
    const visited = new Set(files.map((file) => file.path));
    const sentinels = [
      'build-plugins/shared/salaryLandingShell.ts',
      'build-plugins/germanBorderMunicipalityPagesPlugin.ts',
      'components/shared/LeadMagnetCTA.tsx',
      'data/faq-hub/category-lamal.ts',
      'services/seo/faq-translations.ts',
    ];
    for (const sentinel of sentinels) {
      expect(visited.has(sentinel), `sentinel not visited: ${sentinel}`).toBe(true);
    }
    for (const root of ['build-plugins', 'components', 'data', 'services'] as const) {
      const withHealth = files.some(
        (file) => file.path.startsWith(`${root}/`) && file.lines.some((line) => HEALTH.test(line)),
      );
      expect(withHealth, `no HEALTH line seen under ${root}`).toBe(true);
    }
  });
});
