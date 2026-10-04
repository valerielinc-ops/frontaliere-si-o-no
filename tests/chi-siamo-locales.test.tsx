import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { AutorePage } from '@/components/pages/AutorePage';
import { getMergedAuthor } from '@/services/authorProfileService';
import { AUTHOR_PAGE_COPY } from '@/services/authorPageCopy';
import type { Locale } from '@/services/i18n';
import { ChiSiamo } from '@/components/pages/ChiSiamo';
import { AUTHORS } from '@/data/authors';
import { localizeAuthor } from '@/data/authorLocales';
import { buildPath } from '@/services/router';

const state = vi.hoisted(() => ({ locale: 'it' as Locale }));
vi.mock('@/services/i18n', async importOriginal => ({
  ...await importOriginal<typeof import('@/services/i18n')>(),
  useLocale: () => [state.locale, vi.fn()],
  useTranslation: () => ({ locale: state.locale }),
}));
vi.mock('@/services/NavigationContext', () => ({ useNavigation: () => ({ navigateTo: vi.fn() }) }));

vi.mock('@/services/authorProfileService', () => ({ getMergedAuthor: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const cases = [
  ['it', 'Chi Siamo', 'Politica editoriale', 'Contatti e Segnalazioni'],
  ['en', 'About us', 'Editorial policy', 'Contacts and reports'],
  ['de', 'Über uns', 'Redaktionelle Grundsätze', 'Kontakt und Hinweise'],
  ['fr', 'À propos', 'Politique éditoriale', 'Contacts et signalements'],
] as const;

describe('ChiSiamo locale rendering', () => {
  it.each(cases)('renders %s headings, author roles and local navigation', (locale, title, policy, contacts) => {
    state.locale = locale;
    const document = new DOMParser().parseFromString(renderToStaticMarkup(<ChiSiamo />), 'text/html');
    expect(document.querySelector('h1')?.textContent).toBe(title);
    const headings = Array.from(document.querySelectorAll('h2'), heading => heading.textContent);
    expect(headings).toContain(policy);
    expect(headings).toContain(contacts);
    for (const tab of ['metodologia', 'correzioni', 'privacy'] as const) {
      expect(document.querySelector(`a[href="${buildPath({ activeTab: tab }, locale)}"]`)).not.toBeNull();
    }
    for (const author of AUTHORS) {
      const href = buildPath({ activeTab: 'autore', author: author.slug }, locale);
      expect(document.querySelector(`a[href="${href}"]`)).not.toBeNull();
      expect(document.body.textContent).toContain(localizeAuthor(author, locale).role);
    }
    if (locale !== 'it') {
      expect(document.body.textContent).not.toContain('Torna alla Home');
      expect(document.body.textContent).not.toContain('Ogni articolo è basato');
      expect(document.querySelector('a[href="/metodologia/"]')).toBeNull();
    }
    for (const id of ['finanziamento', 'standard-giornalistici', 'team', 'contatti']) {
      expect(document.getElementById(id)).not.toBeNull();
    }
  });
});


describe('AutorePage locale changes', () => {
  it('updates visible biography, labels and Person URL across all four locales after the profile resolves', async () => {
    const author = AUTHORS[0];
    vi.mocked(getMergedAuthor).mockResolvedValue(author);
    state.locale = 'it';
    const view = render(<AutorePage slug={author.slug} />);
    await waitFor(() => expect(getMergedAuthor).toHaveBeenCalledWith(author.slug));
    for (const locale of ['it', 'en', 'de', 'fr'] as const) {
      state.locale = locale;
      view.rerender(<AutorePage slug={author.slug} />);
      const translated = localizeAuthor(author, locale);
      await waitFor(() => {
        expect(view.getByText(translated.bio)).toBeTruthy();
        expect(view.getByRole('heading', { name: AUTHOR_PAGE_COPY[locale].biography })).toBeTruthy();
        expect(view.getByRole('button', { name: AUTHOR_PAGE_COPY[locale].back })).toBeTruthy();
        const jsonLd = JSON.parse(view.container.querySelector('script[type="application/ld+json"]')!.textContent!);
        expect(jsonLd.url).toBe(`https://frontaliereticino.ch${buildPath({ activeTab: 'autore', author: author.slug }, locale)}`);
        expect(jsonLd.description).toBe(translated.bio);
        expect(jsonLd.jobTitle).toBe(translated.role);
      });
      if (locale !== 'it') expect(view.queryByText(author.bio)).toBeNull();
    }
  });
});
