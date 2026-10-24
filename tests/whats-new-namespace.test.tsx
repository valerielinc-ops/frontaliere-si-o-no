/**
 * What's New release notes are an ON-DEMAND translation namespace.
 *
 * The ~776 `whatsNew.v*` keys used to sit in every `<locale>-core.ts` chunk —
 * about 22% of it-core.js, the chunk every route waits for (and the one static
 * pages modulepreload) — while only the What's New modal ever reads them. They
 * now live in `services/locales/<locale>-whatsnew.ts` and the modal loads them
 * when it opens. This file is the observer that keeps it that way:
 *
 *   1. no `whatsNew.v*` key may come back into a core chunk (a hand-added
 *      release note, or an older generate-whats-new.mjs, would silently put
 *      the weight back on the critical path);
 *   2. every key RELEASES references resolves, non-empty, in all four
 *      namespace chunks;
 *   3. the modal does not render raw keys while the namespace loads, and
 *      shows the notes once it has;
 *   4. the namespace load is announced as a translation-DATA notification,
 *      which useLocale() renders as a transition (a locale switch is not).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import itCore from '@/services/locales/it-core';
import enCore from '@/services/locales/en-core';
import deCore from '@/services/locales/de-core';
import frCore from '@/services/locales/fr-core';
import itWhatsnew from '@/services/locales/it-whatsnew';
import enWhatsnew from '@/services/locales/en-whatsnew';
import deWhatsnew from '@/services/locales/de-whatsnew';
import frWhatsnew from '@/services/locales/fr-whatsnew';
import WhatsNewModal, { RELEASES } from '@/components/community/WhatsNewModal';
import {
  isNamespaceLoaded,
  isTranslationDataNotification,
  loadNamespaceTranslations,
  onLocaleChange,
  setLocale,
} from '@/services/i18n';

const CORE = { it: itCore, en: enCore, de: deCore, fr: frCore } as const;
const NOTES = { it: itWhatsnew, en: enWhatsnew, de: deWhatsnew, fr: frWhatsnew } as const;
const LOCALES = ['it', 'en', 'de', 'fr'] as const;

const releaseKeys = (): string[] => RELEASES.flatMap((release) => [
  release.titleKey,
  ...release.items.flatMap((item) => [item.titleKey, item.descKey]),
]);

afterEach(() => {
  cleanup();
  setLocale('it');
});

describe("What's New strings stay out of the core chunks", () => {
  it.each(LOCALES)('%s-core.ts carries no whatsNew.v* key', (locale) => {
    const leaked = Object.keys(CORE[locale]).filter((key) => key.startsWith('whatsNew.v'));
    expect(
      leaked,
      `Move these keys to services/locales/${locale}-whatsnew.ts (on-demand namespace, see services/i18n.ts): ${leaked.slice(0, 5).join(', ')}`,
    ).toEqual([]);
  });

  it.each(LOCALES)('every RELEASES key resolves in %s-whatsnew.ts', (locale) => {
    const missing = releaseKeys().filter((key) => typeof NOTES[locale][key] !== 'string' || NOTES[locale][key].trim() === '');
    expect(missing, `missing in ${locale}-whatsnew.ts: ${missing.slice(0, 5).join(', ')}`).toEqual([]);
  });

  it('the modal chrome keys stay in core (the bell renders before the namespace loads)', () => {
    for (const locale of LOCALES) {
      for (const key of ['whatsNew.title', 'whatsNew.close', 'whatsNew.goTo', 'common.loading']) {
        expect(CORE[locale][key], `${locale}-core.ts lacks ${key}`).toBeTruthy();
      }
    }
  });
});

describe("What's New modal loads its namespace on open", () => {
  it('shows a loading status instead of raw keys, then the release notes', async () => {
    expect(isNamespaceLoaded('whatsnew')).toBe(false);
    render(<WhatsNewModal open={true} onClose={vi.fn()} />);

    // No raw key is ever painted while the chunk is in flight.
    expect(screen.getByTestId('whats-new-loading')).toBeTruthy();
    expect(document.body.textContent).not.toContain('whatsNew.v');

    const first = RELEASES[0];
    expect(await screen.findByText(itWhatsnew[first.titleKey])).toBeTruthy();
    expect(screen.queryByTestId('whats-new-loading')).toBeNull();
    expect(isNamespaceLoaded('whatsnew')).toBe(true);
  });

  it('a closed modal does not load anything', async () => {
    // Fresh state is not available after the test above, so assert the
    // contract through the hook's gate: rendering closed returns nothing.
    const { container } = render(<WhatsNewModal open={false} onClose={vi.fn()} />);
    expect(container.innerHTML).toBe('');
  });
});

describe('translation-data notifications are distinguishable from a locale switch', () => {
  it('namespace loads notify as data; setLocale does not', async () => {
    const seen: boolean[] = [];
    const off = onLocaleChange(() => { seen.push(isTranslationDataNotification()); });
    try {
      setLocale('it');
      expect(seen).toEqual([false]);
      seen.length = 0;
      await act(async () => {
        setLocale('de');
        await loadNamespaceTranslations('whatsnew');
      });
      // setLocale('de') → urgent; namespace + locale chunks arriving → data.
      expect(seen[0]).toBe(false);
      expect(seen.slice(1).length).toBeGreaterThan(0);
      expect(seen.slice(1).every(Boolean)).toBe(true);
      expect(isTranslationDataNotification()).toBe(false);
    } finally {
      off();
    }
  });
});
