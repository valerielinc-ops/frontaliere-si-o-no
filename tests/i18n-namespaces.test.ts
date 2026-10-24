/**
 * On-demand translation namespaces split out of the core chunks.
 *
 * Every family of keys that only one lazy surface reads lives in
 * `services/locales/<locale>-ns-<name>.ts`, loaded by that surface through
 * useTranslationNamespace(), instead of in `<locale>-core.ts`, which every
 * route waits for and static pages modulepreload. The Italian file of each
 * namespace declares which families it owns (KEY_PREFIXES) and which of their
 * keys must stay in core because something outside the namespace renders them
 * (KEEP_IN_CORE). This file is the observer: a key of an owned family that
 * comes back into a core chunk — hand-added, or by a script that still writes
 * core — fails here, with the file to move it to.
 *
 * Adding a namespace needs no edit here: the glob picks the new files up.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import itCore from '@/services/locales/it-core';
import enCore from '@/services/locales/en-core';
import deCore from '@/services/locales/de-core';
import frCore from '@/services/locales/fr-core';

type NamespaceModule = {
  default: Record<string, string>;
  KEY_PREFIXES?: readonly string[];
  KEEP_IN_CORE?: readonly string[];
};

const LOCALES = ['it', 'en', 'de', 'fr'] as const;
type Locale = (typeof LOCALES)[number];
const CORE: Record<Locale, Record<string, string>> = { it: itCore, en: enCore, de: deCore, fr: frCore };

const modules = import.meta.glob<NamespaceModule>('../services/locales/*-ns-*.ts', { eager: true });
const byNamespace = new Map<string, Partial<Record<Locale, NamespaceModule>>>();
for (const [file, mod] of Object.entries(modules)) {
  const match = /\/(it|en|de|fr)-ns-([a-z0-9-]+)\.ts$/.exec(file);
  if (!match) continue;
  const entry = byNamespace.get(match[2]) ?? {};
  entry[match[1] as Locale] = mod;
  byNamespace.set(match[2], entry);
}
const namespaces = [...byNamespace.keys()].sort();

describe('on-demand translation namespaces', () => {
  it('can be imported by the Node-side Vite config bundle', () => {
    const output = execFileSync(
      process.execPath,
      ['--import', 'tsx', '--eval', "import('./services/i18n.ts').then(() => console.log('i18n-node-load-ok'))"],
      { cwd: resolve(__dirname, '..'), encoding: 'utf8' },
    );
    expect(output).toContain('i18n-node-load-ok');
  });

  it('the glob finds the namespaces (the observer is not vacuous)', () => {
    expect(namespaces.length).toBeGreaterThan(0);
  });

  describe.each(namespaces)('namespace "%s"', (name) => {
    const files = byNamespace.get(name)!;
    const it_ = files.it;

    it('has an Italian file declaring the families it owns', () => {
      expect(it_, `services/locales/it-ns-${name}.ts is missing`).toBeTruthy();
      expect(it_!.KEY_PREFIXES?.length, `it-ns-${name}.ts must export KEY_PREFIXES`).toBeGreaterThan(0);
    });

    it.each(LOCALES)('no owned key is back in %s-core.ts', (locale) => {
      const prefixes = it_?.KEY_PREFIXES ?? [];
      const keep = new Set(it_?.KEEP_IN_CORE ?? []);
      const leaked = Object.keys(CORE[locale]).filter((key) => prefixes.some((p) => key.startsWith(p)) && !keep.has(key));
      expect(
        leaked,
        `move to services/locales/${locale}-ns-${name}.ts (on-demand namespace): ${leaked.slice(0, 5).join(', ')}`,
      ).toEqual([]);
    });

    it('every owned key outside KEEP_IN_CORE lives in the namespace, in all four locales', () => {
      const itKeys = Object.keys(it_?.default ?? {}).sort();
      expect(itKeys.length).toBeGreaterThan(0);
      for (const locale of LOCALES) {
        const keys = Object.keys(files[locale]?.default ?? {}).sort();
        expect(keys, `${locale}-ns-${name}.ts does not match it-ns-${name}.ts`).toEqual(itKeys);
        const empty = keys.filter((k) => !files[locale]!.default[k]?.trim());
        expect(empty, `${locale}-ns-${name}.ts has empty strings`).toEqual([]);
      }
    });

    it('KEEP_IN_CORE keys are really in every core chunk', () => {
      for (const key of it_?.KEEP_IN_CORE ?? []) {
        for (const locale of LOCALES) expect(CORE[locale][key], `${locale}-core.ts lacks ${key}`).toBeTruthy();
      }
    });
  });
});
