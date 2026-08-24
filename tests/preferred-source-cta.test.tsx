/**
 * PreferredSourceCTA — osservatore della fase 4 della issue 5004.
 *
 * Perche' questo file esiste: l'eleggibilita' tecnica a Google Preferred
 * Sources (schema NewsArticle, robots.txt, sitemap fresca, entita'
 * `#organization`) era completa, ma la SELEZIONE la fa l'utente dal proprio
 * account Google — e per mesi nessuna superficie del sito ha portato a quel
 * pannello. La issue e' stata chiusa `completed` senza che il codice
 * esistesse, e nessun test se ne e' accorto perche' non c'era niente da
 * testare.
 *
 * Quindi questo file non verifica solo che il componente si comporti bene:
 * verifica che sia MONTATO dove serve. Un componente corretto e non montato
 * e' esattamente il difetto che stiamo chiudendo, e il render da solo non lo
 * vede — da qui la parte di source scan su App.tsx e BlogArticles.tsx.
 */
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { render, screen, cleanup } from '@testing-library/react';

import PreferredSourceCTA, {
  PREFERRED_SOURCE_URL,
} from '@/components/shared/PreferredSourceCTA';
import { buildNewsletter } from '@/services/newsletter-template.mjs';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

const trackCtaClick = vi.fn();

vi.mock('@/services/analytics', () => ({
  Analytics: {
    trackCtaClick: (...args: unknown[]) => trackCtaClick(...args),
  },
}));

vi.mock('@/services/i18n', () => ({
  useTranslation: () => ({
    t: (key: string) => `[[${key}]]`,
    locale: 'it' as const,
  }),
}));

beforeEach(() => trackCtaClick.mockClear());
afterEach(() => cleanup());

describe('PreferredSourceCTA — deep link', () => {
  it('punta al pannello Preferred Sources di Google col dominio canonico', () => {
    // Il dominio canonico e' senza `www` (AGENTS.md -> Architecture): passarlo
    // con `www` in `q` significa chiedere a Google di preferire un hostname
    // che noi 301-redirectiamo, cioe' un match che puo' non risolvere.
    expect(PREFERRED_SOURCE_URL).toBe(
      'https://www.google.com/preferences/source?q=frontaliereticino.ch',
    );
    expect(new URL(PREFERRED_SOURCE_URL).searchParams.get('q')).toBe(
      'frontaliereticino.ch',
    );
  });

  for (const variant of ['inline', 'card'] as const) {
    it(`variant="${variant}" rende un link esterno sicuro e con nome accessibile`, () => {
      render(<PreferredSourceCTA variant={variant} />);
      const link = screen.getByRole('link', { name: '[[preferredSource.button]]' });

      expect(link).toHaveAttribute('href', PREFERRED_SOURCE_URL);
      expect(link).toHaveAttribute('target', '_blank');
      // `noopener` senza `noreferrer` lascia passare il Referer, e con
      // `target=_blank` lascia anche `window.opener` sfruttabile.
      expect(link.getAttribute('rel')).toContain('noopener');
      expect(link.getAttribute('rel')).toContain('noreferrer');
    });

    it(`variant="${variant}" traccia il click con cta_id distinto per superficie`, () => {
      render(<PreferredSourceCTA variant={variant} />);
      screen.getByRole('link', { name: '[[preferredSource.button]]' }).click();

      expect(trackCtaClick).toHaveBeenCalledTimes(1);
      const [ctaId, details] = trackCtaClick.mock.calls[0] as [
        string,
        Record<string, string>,
      ];
      // Se le due superfici condividessero il cta_id, il funnel non potrebbe
      // dire se converte il footer o la fine-articolo — cioe' la misura che
      // serve a decidere se la CTA vale il suo spazio.
      expect(ctaId).toBe(
        variant === 'inline'
          ? 'footer_preferred_source_cta'
          : 'article_preferred_source_cta',
      );
      expect(details.targetUrl).toBe(PREFERRED_SOURCE_URL);
      expect(details.component).toBe('PreferredSourceCTA');
      expect(details.utm_campaign).toBe('preferred_sources');
      expect(details.section).toBe(
        variant === 'inline' ? 'site_footer' : 'article_end',
      );
    });
  }

  it('default variant = inline (montaggio footer senza prop esplicita)', () => {
    render(<PreferredSourceCTA />);
    expect(screen.getByTestId('preferred-source-cta-inline')).toBeTruthy();
  });

  it('non usa prefissi dark: ne colori hex inline', () => {
    const src = read('components/shared/PreferredSourceCTA.tsx');
    expect(src).not.toMatch(/\bdark:/);
    // L'unico `#` ammesso e' nell'URL di Google, che non e' un colore.
    const classAttrs = src.match(/className="[^"]*"/g) ?? [];
    for (const attr of classAttrs) expect(attr).not.toMatch(/#[0-9a-fA-F]{3,8}/);
  });
});

describe('PreferredSourceCTA — e montato dove la issue 5004 lo chiede', () => {
  it('footer del sito (App.tsx): import + render', () => {
    const src = read('App.tsx');
    expect(src).toContain("import('@/components/shared/PreferredSourceCTA')");
    expect(src).toMatch(/<PreferredSourceCTA\s+variant="inline"\s*\/>/);
  });

  it('fine articolo (BlogArticles.tsx): import + render non gateato per categoria', () => {
    const src = read('components/community/BlogArticles.tsx');
    expect(src).toContain("import('@/components/shared/PreferredSourceCTA')");
    expect(src).toMatch(/<PreferredSourceCTA\s+variant="card"\s*\/>/);

    // ConsultingCTA e' volutamente gateato su `category === 'fiscale'`; la CTA
    // Preferred Sources no, perche' la scelta vale per il dominio intero. Se
    // qualcuno la infilasse dentro quel ramo, coprirebbe una frazione degli
    // articoli e la fase 4 tornerebbe parziale senza che nulla diventi rosso.
    const fiscalGate = /article\.category === 'fiscale' && \(([\s\S]*?)\n \)\}/;
    const gated = src.match(fiscalGate);
    expect(gated).not.toBeNull();
    expect(gated![1]).not.toContain('PreferredSourceCTA');
  });

  it('newsletter (HTML email): il deep link esce in tutti e 4 i locali', () => {
    for (const locale of ['it', 'en', 'de', 'fr'] as const) {
      const html = buildNewsletter({
        exchangeRate: { rate: 0.942, previousRate: 0.95 },
        matchedJobs: [],
        totalJobs: 42,
        locale,
        unsubscribeUrl: 'https://frontaliereticino.ch/u/x',
      });
      expect(html).toContain(PREFERRED_SOURCE_URL);
      // Una chiave di traduzione mancante qui uscirebbe come `undefined`
      // dentro il corpo dell'email, non come un errore.
      expect(html).not.toContain('undefined');
    }
  });

  it('le due copie dell URL (React ed email) non possono divergere in silenzio', () => {
    // I due file non possono importarsi a vicenda (componente React vs
    // template .mjs usato dagli script di invio), quindi la costante e'
    // duplicata per necessita': questo assert e' il guard che tiene le due
    // copie identiche.
    const emailSrc = read('services/newsletter-template.mjs');
    expect(emailSrc).toContain(`'${PREFERRED_SOURCE_URL}'`);
  });
});

describe('Fase 1 della issue 5004 — checklist di eleggibilita', () => {
  it('docs/preferred-sources-checklist.md esiste, registra lo stato verificato di Publisher Center e nomina cio che resta bloccato', () => {
    // Il deliverable della fase 1 non era mai stato creato: la issue e' stata
    // chiusa `completed` con la checklist inesistente. Il file e' la sola cosa
    // che documenta lo stato reale su publishercenter.google.com (verificato
    // dal vivo: gia' completo) e cosa resta bloccato su una persona (il post
    // social), quindi la sua assenza e' un regresso.
    const doc = read('docs/preferred-sources-checklist.md');
    expect(doc).toContain('publishercenter.google.com');
    expect(doc).toMatch(/blocked:/);
    expect(doc).toContain(PREFERRED_SOURCE_URL);
  });
});
