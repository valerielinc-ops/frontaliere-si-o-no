import React, { useMemo } from 'react';
import {
  ArrowLeft,
  ScrollText,
  Mail,
  Clock,
  CheckCircle2,
  AlertTriangle,
  ListChecks,
} from 'lucide-react';
import { useNavigation } from '@/services/NavigationContext';
import correctionsLog from '@/data/corrections-log.json';

/**
 * Correzioni — /correzioni/ public corrections policy + chronological log.
 *
 * Required for Google News compliance (FASE 2 B1):
 * - Public corrections policy with SLA, accepted types, contact channel.
 * - Public chronological log of every correction made on the site.
 * - WebPage JSON-LD with `lastReviewed` so crawlers see freshness signal.
 *
 * Source of truth: data/corrections-log.json (appended via
 * scripts/log-correction.mjs <articleId> <type> "<description>").
 */

type CorrectionType = 'factual' | 'typo' | 'clarification';

interface CorrectionEntry {
  date: string;
  articleId: string;
  type: CorrectionType;
  description: string;
}

interface CorrectionsLog {
  version: number;
  policy: {
    sla_hours: number;
    types: CorrectionType[];
    contactEmail: string;
  };
  entries: CorrectionEntry[];
}

const TYPE_LABELS: Record<CorrectionType, string> = {
  factual: 'Errore fattuale',
  typo: 'Refuso',
  clarification: 'Chiarimento',
};

const TYPE_DESCRIPTIONS: Record<CorrectionType, string> = {
  factual:
    'Dato numerico, citazione o affermazione errata che modifica la sostanza dell\'articolo.',
  typo: 'Errore di battitura, ortografico o di formattazione che non modifica il significato.',
  clarification:
    'Aggiunta di contesto o precisazione che migliora la comprensione senza correggere un errore.',
};

const log = correctionsLog as CorrectionsLog;

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString('it-IT', {
      day: '2-digit',
      month: 'long',
      year: 'numeric',
    });
  } catch {
    return iso;
  }
}

function resolveLastReviewed(entries: CorrectionEntry[]): string {
  if (entries.length === 0) {
    // No corrections yet — anchor freshness on today's date.
    return new Date().toISOString().slice(0, 10);
  }
  const sorted = [...entries].sort((a, b) =>
    a.date < b.date ? 1 : a.date > b.date ? -1 : 0,
  );
  return sorted[0].date.slice(0, 10);
}

export const Correzioni: React.FC = () => {
  const nav = useNavigation();

  const sortedEntries = useMemo(
    () =>
      [...log.entries].sort((a, b) =>
        a.date < b.date ? 1 : a.date > b.date ? -1 : 0,
      ),
    [],
  );

  const lastReviewed = useMemo(
    () => resolveLastReviewed(log.entries),
    [],
  );

  const jsonLd = useMemo(() => {
    return {
      '@context': 'https://schema.org',
      '@type': 'WebPage',
      name: 'Correzioni — Frontaliere Ticino',
      url: 'https://frontaliereticino.ch/correzioni/',
      description:
        'Politica di correzione pubblica e registro cronologico delle rettifiche pubblicate da Frontaliere Ticino.',
      inLanguage: 'it',
      lastReviewed,
      mainEntity: {
        '@type': 'CreativeWork',
        name: 'Politica di correzione di Frontaliere Ticino',
        about: 'Editorial corrections policy and public log',
        publisher: { '@id': 'https://frontaliereticino.ch/#organization' },
      },
    };
  }, [lastReviewed]);

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 animate-fade-in">
      {/* Inline JSON-LD WebPage with lastReviewed */}
      <script
        type="application/ld+json"
        // Stable serialization (no whitespace) — easier diffs in dist.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      {/* Back button */}
      <button
        onClick={() => nav.navigateTo('calculator')}
        className="mb-6 inline-flex items-center gap-2 text-sm font-semibold text-accent hover:text-accent transition-colors"
      >
        <ArrowLeft size={16} />
        Torna alla Home
      </button>

      {/* Hero */}
      <div className="bg-surface rounded-2xl border border-edge p-5 sm:p-8 shadow-lg mb-6">
        <div className="flex items-center gap-4 mb-4">
          <div className="p-3 bg-info rounded-2xl shadow-lg">
            <ScrollText className="text-on-accent" size={32} />
          </div>
          <div>
            <h1 className="text-2xl sm:text-3xl font-extrabold font-display text-strong">
              Correzioni
            </h1>
            <p className="text-sm text-muted mt-1">
              Policy di rettifica e registro pubblico delle correzioni
            </p>
          </div>
        </div>
        <p className="text-subtle leading-relaxed">
          La trasparenza editoriale è un pilastro del nostro lavoro. Quando
          pubblichiamo un dato sbagliato, una citazione imprecisa o un refuso
          che cambia il senso di una frase, lo correggiamo entro{' '}
          <strong>{log.policy.sla_hours} ore</strong> e ne teniamo traccia in
          questa pagina. Ogni rettifica è registrata con data, tipo, articolo
          interessato e una breve descrizione di cosa è cambiato — così chi
          legge può verificare in qualsiasi momento la nostra storia editoriale.
        </p>
      </div>

      <div className="space-y-6">
        {/* How to report */}
        <Section icon={Mail} title="Come segnalare un errore">
          <p>
            Se trovi un errore in un articolo, in un calcolatore o in un dato
            pubblicato, scrivi a{' '}
            <a
              href={`mailto:${log.policy.contactEmail}?subject=Segnalazione%20correzione`}
              className="text-accent hover:underline font-medium"
            >
              {log.policy.contactEmail}
            </a>
            . Indica:
          </p>
          <ul className="mt-3 space-y-2">
            <BulletItem>
              <strong>URL della pagina</strong> oppure il titolo dell'articolo
            </BulletItem>
            <BulletItem>
              <strong>Frase o dato contestato</strong> (citazione esatta)
            </BulletItem>
            <BulletItem>
              <strong>Fonte</strong> ufficiale che dimostra l'errore (link a
              ESTV, Agenzia delle Entrate, BFS, INPS, gazzetta ufficiale, ecc.)
            </BulletItem>
          </ul>
          <p className="mt-3">
            Ti rispondiamo entro {log.policy.sla_hours} ore lavorative. Se la
            segnalazione è fondata, correggiamo l'articolo, registriamo la
            modifica in questa pagina e — se la correzione è sostanziale —
            aggiungiamo una nota visibile in cima all'articolo originale.
          </p>
        </Section>

        {/* SLA */}
        <Section icon={Clock} title={`SLA di correzione: ${log.policy.sla_hours} ore`}>
          <p>
            Ci impegniamo a verificare ogni segnalazione entro{' '}
            {log.policy.sla_hours} ore dalla ricezione. Se la rettifica è
            confermata, l'articolo viene aggiornato immediatamente e la voce
            corrispondente viene aggiunta al registro pubblico qui sotto.
          </p>
          <p className="mt-3">
            Se la segnalazione richiede approfondimento (per esempio una
            verifica con un'amministrazione fiscale o un'agenzia), forniamo una
            risposta interlocutoria entro la stessa finestra e completiamo la
            verifica appena possibile.
          </p>
        </Section>

        {/* Types accepted */}
        <Section icon={ListChecks} title="Tipologie di correzione accettate">
          <div className="space-y-4">
            {log.policy.types.map((t) => (
              <div key={t}>
                <p className="font-semibold text-strong">
                  {TYPE_LABELS[t]} <span className="text-muted text-xs font-normal">({t})</span>
                </p>
                <p className="text-sm text-subtle mt-1">{TYPE_DESCRIPTIONS[t]}</p>
              </div>
            ))}
          </div>
        </Section>

        {/* Public log */}
        <Section icon={AlertTriangle} title="Registro pubblico delle correzioni">
          {sortedEntries.length === 0 ? (
            <p className="text-subtle">
              Nessuna correzione registrata finora — questa è una buona notizia.
              Continueremo a tenere traccia di ogni rettifica qui, in ordine
              cronologico inverso, così potrai verificare la nostra storia
              editoriale in qualsiasi momento.
            </p>
          ) : (
            <ol className="space-y-4" data-testid="corrections-list">
              {sortedEntries.map((entry, idx) => (
                <li
                  key={`${entry.date}-${entry.articleId}-${idx}`}
                  className="border-l-2 border-accent/40 pl-4 py-1"
                >
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted mb-1">
                    <time dateTime={entry.date} className="font-mono">
                      {formatDate(entry.date)}
                    </time>
                    <span aria-hidden="true">·</span>
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-info-subtle text-info rounded-full font-semibold">
                      {TYPE_LABELS[entry.type] || entry.type}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span className="font-mono text-muted">
                      Articolo: {entry.articleId}
                    </span>
                  </div>
                  <p className="text-sm text-subtle leading-relaxed">
                    {entry.description}
                  </p>
                </li>
              ))}
            </ol>
          )}
        </Section>

        {/* Footer note */}
        <div className="bg-surface rounded-2xl border border-edge p-4 sm:p-6 shadow-sm">
          <h2 className="text-lg font-bold font-display text-strong mb-3">
            Indipendenza editoriale
          </h2>
          <p className="text-sm text-subtle leading-relaxed">
            Frontaliere Ticino è una piattaforma indipendente. Non riceviamo
            compensi da banche, casse malati o datori di lavoro citati negli
            articoli. Le correzioni vengono effettuate solo sulla base di prove
            verificabili (fonti istituzionali, normative, dati ufficiali). Per
            altre informazioni sulla redazione consulta la pagina{' '}
            <button
              onClick={() => nav.navigateTo('chi-siamo' as never)}
              className="text-accent hover:underline font-medium"
            >
              Chi Siamo
            </button>
            .
          </p>
        </div>
      </div>
    </div>
  );
};

/* ── Reusable sub-components (mirror ChiSiamo.tsx pattern) ── */

interface SectionProps {
  icon: React.FC<{ size?: number; className?: string }>;
  title: string;
  children: React.ReactNode;
}

function Section({ icon: Icon, title, children }: SectionProps) {
  return (
    <div className="bg-surface rounded-2xl border border-edge p-4 sm:p-6 shadow-sm">
      <div className="flex items-center gap-3 mb-4">
        <Icon size={20} className="text-accent" />
        <h2 className="text-lg font-bold font-display text-strong">{title}</h2>
      </div>
      <div className="text-sm text-subtle leading-relaxed">{children}</div>
    </div>
  );
}

function BulletItem({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <CheckCircle2 size={14} className="text-success mt-0.5 shrink-0" />
      <span>{children}</span>
    </li>
  );
}

export default Correzioni;
