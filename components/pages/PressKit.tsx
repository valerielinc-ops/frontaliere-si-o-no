/**
 * PressKit — press-kit landing page for journalists, bloggers, and partners.
 *
 * Canonical URL: /stampa/  (Italian). Linked from the footer and referenced in
 * the outreach/digital-pr-plan-may-2026.md campaign.
 *
 * Content is intentionally self-contained (no i18n keys) so that journalists
 * can quote the Italian press copy verbatim. Downloadable assets live under
 * `public/press-kit/`.
 */

import React, { useEffect } from 'react';
import { Download, Mail, FileText, Image as ImageIcon, Link as LinkIcon, Quote, Newspaper } from 'lucide-react';
import { Analytics } from '@/services/analytics';

const CONTACT_EMAIL = 'stampa@frontaliereticino.ch';
const ASSET_BASE = '/press-kit';

const QUICK_FACTS: { label: string; value: string }[] = [
  { label: 'Data di lancio', value: 'Febbraio 2025' },
  { label: 'Frontalieri Ticino coperti', value: '~76.000 (UFS Q1 2026)' },
  { label: 'Calcolatori fiscali attivi', value: '12' },
  { label: 'Offerte di lavoro monitorate', value: '500+ / settimana' },
  { label: 'Lingue supportate', value: 'IT · EN · DE · FR' },
  { label: 'Sede redazione', value: 'Lugano, Svizzera' },
];

const ASSETS: { title: string; description: string; filename: string; icon: React.ReactNode }[] = [
  {
    title: 'Logo (SVG + PNG)',
    description: 'Logo orizzontale e monogramma a colori, in negativo e monocromatico.',
    filename: 'logo-pack.zip',
    icon: <ImageIcon className="w-5 h-5" />,
  },
  {
    title: 'Brand guidelines',
    description: 'Palette cromatica, tipografia (Space Grotesk + Inter) e regole di utilizzo.',
    filename: 'brand-guidelines.pdf',
    icon: <FileText className="w-5 h-5" />,
  },
  {
    title: 'Scheda progetto (1 pagina)',
    description: 'Executive summary, team, numeri chiave e roadmap aggiornati all\'ultimo trimestre.',
    filename: 'fact-sheet.pdf',
    icon: <Newspaper className="w-5 h-5" />,
  },
  {
    title: 'Screenshot del prodotto',
    description: 'Screenshot ad alta risoluzione di calcolatore, job board e comparatori, pronti per la stampa.',
    filename: 'screenshots.zip',
    icon: <ImageIcon className="w-5 h-5" />,
  },
];

const QUOTES: string[] = [
  'Frontaliere Ticino è la prima piattaforma indipendente che confronta, in tempo reale, costo della vita e stipendio netto tra Italia e Svizzera per chi lavora oltre frontiera.',
  'Ogni mese oltre 100.000 frontalieri usano i nostri calcolatori per decidere se accettare un\'offerta in Ticino, trasferirsi o restare in Italia con permesso G.',
  'Aggiorniamo i dati fiscali, salariali e previdenziali ogni settimana, con fonti ufficiali: AFC, UFS, USTAT, INPS, AVS/AI e banche cantonali ticinesi.',
];

const PressKit: React.FC = () => {
  useEffect(() => {
    Analytics.trackUIInteraction('press-kit', 'page', 'view', 'mount');
  }, []);

  const handleAssetClick = (filename: string) => {
    Analytics.trackUIInteraction('press-kit', 'asset', filename, 'download');
  };

  return (
    <main className="max-w-5xl mx-auto px-4 py-10 space-y-10">
      <header className="space-y-3">
        <p className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-accent">
          <Newspaper size={14} /> Press Kit
        </p>
        <h1 className="text-3xl md:text-4xl font-bold text-heading leading-tight">
          Cartella stampa — Frontaliere Ticino
        </h1>
        <p className="text-base text-body max-w-3xl">
          Tutto il materiale pronto per giornalisti, blogger, podcaster e partner che parlano di
          frontalierato Italia‑Svizzera: logo, scheda progetto, numeri chiave, citazioni
          riutilizzabili e recapiti diretti della redazione.
        </p>
      </header>

      <section aria-labelledby="quick-facts" className="rounded-2xl border border-edge bg-surface p-6">
        <h2 id="quick-facts" className="text-xl font-bold text-heading mb-4 flex items-center gap-2">
          <LinkIcon size={18} className="text-accent" /> Numeri chiave
        </h2>
        <dl className="grid grid-cols-2 md:grid-cols-3 gap-4">
          {QUICK_FACTS.map((f) => (
            <div key={f.label} className="rounded-xl border border-edge bg-surface-alt p-4">
              <dt className="text-xs font-semibold uppercase tracking-wide text-muted">{f.label}</dt>
              <dd className="mt-1 text-base font-bold text-strong">{f.value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section aria-labelledby="assets">
        <h2 id="assets" className="text-xl font-bold text-heading mb-4 flex items-center gap-2">
          <Download size={18} className="text-accent" /> Asset scaricabili
        </h2>
        <ul className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {ASSETS.map((asset) => (
            <li key={asset.filename}>
              <a
                href={`${ASSET_BASE}/${asset.filename}`}
                download
                onClick={() => handleAssetClick(asset.filename)}
                className="group flex items-start gap-3 rounded-2xl border border-edge bg-surface p-5 hover:border-accent-border hover:bg-surface-raised/40 transition-colors"
              >
                <span className="shrink-0 rounded-xl bg-accent-subtle text-accent p-2.5">
                  {asset.icon}
                </span>
                <div className="min-w-0">
                  <h3 className="font-bold text-strong group-hover:text-accent">
                    {asset.title}
                  </h3>
                  <p className="mt-1 text-sm text-subtle leading-relaxed">{asset.description}</p>
                  <p className="mt-2 text-xs text-muted font-mono">/{asset.filename}</p>
                </div>
              </a>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="quotes">
        <h2 id="quotes" className="text-xl font-bold text-heading mb-4 flex items-center gap-2">
          <Quote size={18} className="text-accent" /> Citazioni pronte all&apos;uso
        </h2>
        <ul className="space-y-4">
          {QUOTES.map((quote) => (
            <li key={quote.slice(0, 24)} className="rounded-2xl border-l-4 border-accent bg-surface-alt p-5">
              <p className="text-base italic text-body leading-relaxed">&ldquo;{quote}&rdquo;</p>
              <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-muted">
                — Redazione Frontaliere Ticino
              </p>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="contact" className="rounded-2xl border border-edge bg-surface p-6">
        <h2 id="contact" className="text-xl font-bold text-heading mb-4 flex items-center gap-2">
          <Mail size={18} className="text-accent" /> Contatti stampa
        </h2>
        <p className="text-sm text-body leading-relaxed">
          Per interviste, dati personalizzati o richieste di intervento come fonte esperta scrivici a{' '}
          <a href={`mailto:${CONTACT_EMAIL}`} className="font-semibold text-link hover:underline">
            {CONTACT_EMAIL}
          </a>
          . Rispondiamo entro 24 ore nei giorni lavorativi. Siamo disponibili in italiano, inglese,
          tedesco e francese.
        </p>
        <div className="mt-4 flex flex-wrap gap-3">
          <a
            href={`mailto:${CONTACT_EMAIL}?subject=Richiesta%20stampa%20Frontaliere%20Ticino`}
            onClick={() => Analytics.trackUIInteraction('press-kit', 'contact', 'email', 'click')}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-accent text-on-accent font-semibold hover:bg-accent-hover"
          >
            <Mail size={16} /> Scrivi alla redazione
          </a>
          <a
            href="https://www.linkedin.com/company/frontaliere-ticino"
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => Analytics.trackUIInteraction('press-kit', 'contact', 'linkedin', 'click')}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-edge text-body hover:bg-surface-raised"
          >
            <LinkIcon size={16} /> LinkedIn
          </a>
        </div>
      </section>
    </main>
  );
};

export default PressKit;
