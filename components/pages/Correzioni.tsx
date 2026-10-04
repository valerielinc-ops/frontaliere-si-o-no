import React, { useMemo } from 'react';
import { ArrowLeft, ScrollText, Mail, Clock, CheckCircle2, AlertTriangle, ListChecks } from 'lucide-react';
import { useNavigation } from '@/services/NavigationContext';
import { useLocale } from '@/services/i18n';
import correctionsLog from '@/data/corrections-log.json';
import { buildCorrezioniSeo } from '@/services/seo/seo-correzioni';
import { CORRECTIONS_COPY, type CorrectionsLog } from '@/services/editorialCorrections';

const log: CorrectionsLog = correctionsLog;

type CorrectionType = 'factual' | 'typo' | 'clarification';
const DATE_LOCALES = { it: 'it-IT', en: 'en-GB', de: 'de-CH', fr: 'fr-CH' } as const;

/** Localized public policy and the entries actually present in the corrections log. */
export const Correzioni: React.FC = () => {
  const nav = useNavigation();
  const [locale] = useLocale();
  const copy = CORRECTIONS_COPY[locale];
  const sortedEntries = useMemo(() => [...log.entries].sort((a, b) => b.date.localeCompare(a.date)), []);
  const jsonLd = useMemo(() => buildCorrezioniSeo(locale).jsonLd, [locale]);
  return (
    <div className="max-w-4xl mx-auto px-4 py-8 animate-fade-in">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, '\\u003c') }} />
      <button onClick={() => nav.navigateTo('calculator')} className="mb-6 inline-flex items-center gap-2 text-sm font-semibold text-accent">
        <ArrowLeft size={16} />{copy.home}
      </button>
      <div className="bg-surface rounded-2xl border border-edge p-5 sm:p-8 shadow-lg mb-6">
        <div className="flex items-center gap-4 mb-4">
          <ScrollText className="text-accent" size={32} />
          <div><h1 className="text-2xl sm:text-3xl font-extrabold font-display text-strong">{copy.title}</h1>
            <p className="text-sm text-muted mt-1">{copy.subtitle}</p></div>
        </div>
        <p className="text-subtle leading-relaxed">{copy.intro}</p>
      </div>
      <div className="space-y-6">
        <Section icon={Mail} title={copy.report}>
          <p>{copy.contact}{' '}<a href={`mailto:${log.policy.contactEmail}`} className="text-accent hover:underline font-medium">{log.policy.contactEmail}</a>.</p>
          <ul className="mt-3 space-y-2">{copy.requirements.map((item) => <BulletItem key={item}>{item}</BulletItem>)}</ul>
        </Section>
        <Section icon={Clock} title={copy.handling}><p>{copy.handlingText}</p></Section>
        <Section icon={ListChecks} title={copy.typesTitle}>
          <div className="space-y-4">{(Object.keys(copy.labels) as CorrectionType[]).map((type) => <div key={type}>
            <p className="font-semibold text-strong">{copy.labels[type]}</p>
            <p className="text-sm text-subtle mt-1">{copy.types[type]}</p>
          </div>)}</div>
        </Section>
        <Section icon={AlertTriangle} title={copy.log}>
          {sortedEntries.length === 0 ? <p className="text-subtle">{copy.empty}</p> : <>
            <p className="mb-4">{copy.sourceNote}</p>
            <ol className="space-y-4" data-testid="corrections-list">{sortedEntries.map((entry, index) => <li key={`${entry.date}-${entry.articleId}-${index}`} className="rounded-lg bg-surface-alt px-4 py-3">
              <div className="flex flex-wrap gap-3 text-xs text-muted mb-1">
                <time dateTime={entry.date}>{Number.isNaN(Date.parse(entry.date)) ? entry.date : new Date(entry.date).toLocaleDateString(DATE_LOCALES[locale], { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'UTC' })}</time>
                <span>{copy.labels[entry.type as CorrectionType] || entry.type}</span>
                <span>{copy.article}: {entry.articleId}</span>
              </div><p className="text-sm text-subtle leading-relaxed">{entry.description}</p>
            </li>)}</ol>
          </>}
        </Section>
      </div>
    </div>
  );
};

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
