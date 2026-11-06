/**
 * Guard for the shared Telegram channel CTA.
 *
 * WHY this test exists (measured 2026-08-24): the Telegram channel had been
 * broadcasting a jobs digest every single day and had **3 subscribers**
 * (`getChatMemberCount` → 3, one of them the posting bot). GA4 property
 * 524485296 reported zero sessions from `t.me` — with an audience of three,
 * that is arithmetic, not a tracking bug. The channel was reachable from the
 * community forum and one footer link and from nowhere else; the newsletter
 * surfaces, which are the site's highest-intent subscription moment, never
 * mentioned it.
 *
 * Two invariants are locked here:
 *
 *  1. **Fail-safe gating.** The CTA must render NOTHING when
 *     `VITE_TELEGRAM_CHANNEL_URL` is unset or malformed. This is the rule
 *     `services/telegramChannel.ts` was written to enforce, and every new call
 *     site is a new chance to forget it — the shared component is what makes
 *     the guarantee structural, and this test is what keeps it true.
 *
 *  2. **Reach.** The three newsletter surfaces actually mount the component.
 *     A CTA nobody renders is exactly the state we are fixing, so an import
 *     that quietly disappears in a refactor has to fail a test, not a
 *     dashboard six weeks later.
 *
 * Invariant 2 is asserted by SOURCE SCAN, not by rendering. Newsletter.tsx and
 * NewsletterPopup.tsx pull in Firestore, Firebase Auth, Google One Tap and the
 * popup queue at module scope; rendering them here would test that mock stack
 * and not the thing in question. Scanning is also the pattern this repo already
 * uses for guards that would otherwise need a plugin's module graph (see
 * CLAUDE.md → "scansiona il sorgente invece di importarlo").
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), 'utf-8');

vi.mock('@/services/i18n', () => ({
  useTranslation: () => ({ t: (key: string) => key, locale: 'it' }),
}));

afterEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
});

async function renderCta(url: string | undefined) {
  vi.resetModules();
  if (url === undefined) vi.stubEnv('VITE_TELEGRAM_CHANNEL_URL', '');
  else vi.stubEnv('VITE_TELEGRAM_CHANNEL_URL', url);

  const [{ render }, mod] = await Promise.all([
    import('@testing-library/react'),
    import('@/components/shared/TelegramChannelCta'),
  ]);
  const Cta = mod.default;
  const { container, unmount } = render(<Cta />);
  const html = container.innerHTML;
  unmount();
  return html;
}

describe('TelegramChannelCta — fail-safe gating', () => {
  it('renders nothing when the channel URL is unset', async () => {
    expect(await renderCta(undefined)).toBe('');
  });

  it('renders nothing for a malformed / non-t.me URL', async () => {
    // Same shape the service's regex rejects — never a dead or wrong link.
    expect(await renderCta('https://example.com/frontaliereticino')).toBe('');
    expect(await renderCta('t.me/frontaliereticino')).toBe('');
    expect(await renderCta('not a url')).toBe('');
  });

  it('renders an external-safe anchor when the channel IS configured', async () => {
    const html = await renderCta('https://t.me/frontaliereticino');
    expect(html).toContain('href="https://t.me/frontaliereticino"');
    expect(html).toContain('target="_blank"');
    // rel must carry BOTH tokens: noopener for the tab-nabbing hole,
    // noreferrer so the outbound click does not leak the referrer.
    expect(html).toContain('noopener');
    expect(html).toContain('noreferrer');
  });
});

describe('TelegramChannelCta — reach', () => {
  const surfaces = [
    'components/community/Newsletter.tsx',
    'components/community/NewsletterPopup.tsx',
  ];

  for (const rel of surfaces) {
    it(`${rel} imports and mounts the shared CTA`, () => {
      const src = read(rel);
      expect(src).toContain("from '@/components/shared/TelegramChannelCta'");
      expect(src).toMatch(/<TelegramChannelCta[\s/>]/);
    });
  }

  it('NewsletterMount inherits the CTA through <Newsletter compact />', () => {
    // No separate wiring by construction: the mount renders Newsletter itself,
    // so covering Newsletter.tsx covers every hydration island it creates.
    const src = read('components/community/NewsletterMount.tsx');
    expect(src).toContain("import Newsletter from './Newsletter'");
    expect(src).toMatch(/<Newsletter\b/);
  });

  it('every surface uses the shared component instead of a re-typed gate', () => {
    // The failure mode this prevents: someone copies the anchor JSX and drops
    // the isTelegramChannelConfigured() check, shipping a dead t.me link.
    for (const rel of surfaces) {
      const src = read(rel);
      expect(src).not.toContain('isTelegramChannelConfigured');
      expect(src).not.toContain('TELEGRAM_CHANNEL_URL');
    }
  });

  it('the i18n keys the CTA renders exist in all four locales', () => {
    for (const loc of ['it', 'en', 'de', 'fr']) {
      const src = read(`services/locales/${loc}-core.ts`);
      expect(src, `${loc}: newsletter.telegram.title`).toContain("'newsletter.telegram.title'");
      expect(src, `${loc}: newsletter.telegram.desc`).toContain("'newsletter.telegram.desc'");
    }
  });
});
