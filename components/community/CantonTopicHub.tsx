import { useEffect, useState } from 'react';
import { useLocale } from '@/services/i18n';
import type { CantonArticleSection } from '@/services/articleSections';
import {
  cantonArchiveCopy,
  cantonSectionArchivePath,
  cantonSectionLabel,
  cantonSectionLandingPath,
  cantonTopicHubLabel,
  cantonTopicHubPath,
} from '@/packages/articles/engine/shared/cantonSectionCopy.mjs';
import { cantonSectionConfig } from '@/services/runtimeArticleSections';
import {
  loadCantonTopicHub,
  type CantonHubDataBlock,
  type CantonHubDataItem,
  type CantonTopicHubData,
} from '@/services/runtimeCantonTopicHubs';

interface HubCopy {
  updated: string;
  keyFacts: string;
  source: string;
  curated: string;
  noCurated: string;
  tools: string;
  otherTopics: string;
  loading: string;
  unavailable: string;
}

interface LoadedHubData {
  key: string;
  data: CantonTopicHubData;
}

const HUB_COPY: Record<'it' | 'en' | 'de' | 'fr', HubCopy> = {
  it: {
    updated: 'Aggiornato il',
    keyFacts: 'Dati chiave',
    source: 'Fonte',
    curated: 'Articoli consigliati',
    noCurated: 'Gli articoli su questo tema compariranno qui man mano che vengono pubblicati.',
    tools: 'Strumenti utili',
    otherTopics: 'Altri temi',
    loading: 'Caricamento dati aggiornati…',
    unavailable: 'I dati aggiornati non sono disponibili in questo momento.',
  },
  en: {
    updated: 'Updated on',
    keyFacts: 'Key data',
    source: 'Source',
    curated: 'Recommended articles',
    noCurated: 'Articles on this topic will appear here as they are published.',
    tools: 'Useful tools',
    otherTopics: 'Other topics',
    loading: 'Loading updated data…',
    unavailable: 'Updated data is not available right now.',
  },
  de: {
    updated: 'Aktualisiert am',
    keyFacts: 'Eckdaten',
    curated: 'Empfohlene Artikel',
    noCurated: 'Artikel zu diesem Thema erscheinen hier, sobald sie veröffentlicht werden.',
    source: 'Quelle',
    tools: 'Nützliche Tools',
    otherTopics: 'Weitere Themen',
    loading: 'Aktualisierte Daten werden geladen…',
    unavailable: 'Aktualisierte Daten sind momentan nicht verfügbar.',
  },
  fr: {
    updated: 'Mis à jour le',
    keyFacts: 'Données clés',
    curated: 'Articles recommandés',
    noCurated: 'Les articles sur ce thème apparaîtront ici au fil de leur publication.',
    source: 'Source',
    tools: 'Outils utiles',
    otherTopics: 'Autres thèmes',
    loading: 'Chargement des données mises à jour…',
    unavailable: 'Les données mises à jour ne sont pas disponibles pour le moment.',
  },
};

const LOCALE_TAGS = { it: 'it-IT', en: 'en-GB', de: 'de-CH', fr: 'fr-CH' } as const;

function formatDate(value: string, locale: keyof typeof HUB_COPY): string {
  return new Date(value).toLocaleDateString(LOCALE_TAGS[locale], {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function SourceLine({
  copy,
  name,
  url,
}: {
  copy: HubCopy;
  name?: string;
  url?: string;
}) {
  if (!name) return null;
  return (
    <p className="mt-3 text-sm text-subtle">
      {copy.source}:{' '}
      {url ? <a href={url} rel="noopener" className="text-accent hover:underline">{name}</a> : name}
    </p>
  );
}

function DataItem({ item, locale }: { item: CantonHubDataItem; locale: keyof typeof HUB_COPY }) {
  return (
    <li className="min-w-0 rounded-xl border border-edge/70 bg-surface-alt/35 px-3 py-3 text-sm leading-6">
      <div className="min-w-0 break-words">
        {item.url ? (
          <a href={item.url} className="font-semibold text-accent hover:underline">{item.label}</a>
        ) : (
          <strong className="font-semibold text-body">{item.label}</strong>
        )}
        {item.value ? <span className="text-body">: {item.value}</span> : null}
      </div>
      {item.detail ? <div className="mt-1 text-subtle">{item.detail}</div> : null}
      {item.date ? <time className="mt-1 block text-xs text-muted" dateTime={item.date}>{formatDate(item.date, locale)}</time> : null}
    </li>
  );
}

function DataBlock({ block, locale, copy }: { block: CantonHubDataBlock; locale: keyof typeof HUB_COPY; copy: HubCopy }) {
  const headingId = `dati-${block.id}`;
  return (
    <section aria-labelledby={headingId} className="border-t border-edge pt-5 first:border-t-0 first:pt-0">
      <h2 id={headingId} className="text-xl font-bold font-display text-heading">{block.title}</h2>
      {block.description ? <p className="mt-2 max-w-4xl text-sm leading-7 text-subtle">{block.description}</p> : null}
      {block.items.length > 0 ? (
        <ul className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3" aria-label={block.title}>
          {block.items.map((item, index) => <DataItem key={`${block.id}-${index}`} item={item} locale={locale} />)}
        </ul>
      ) : null}
      {block.updatedAt ? (
        <p className="mt-3 text-sm text-subtle">
          {copy.updated}{' '}
          <time dateTime={block.updatedAt}>{formatDate(block.updatedAt, locale)}</time>
        </p>
      ) : null}
      <SourceLine copy={copy} name={block.sourceName} url={block.sourceUrl} />
    </section>
  );
}

function CantonTopicHub({
  section,
  topic,
  deferUntilReady,
  onReady,
}: {
  section: CantonArticleSection;
  topic: string;
  deferUntilReady?: boolean;
  onReady?: (key: string) => void;
}) {
  const [locale] = useLocale();
  const [loaded, setLoaded] = useState<LoadedHubData | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const key = `${section}:${topic}:${locale}`;
  const copy = HUB_COPY[locale];
  const data = loaded?.key === key ? loaded.data : null;

  useEffect(() => {
    let cancelled = false;
    setLoaded(null);
    setLoading(true);
    setFailed(false);
    void loadCantonTopicHub(section, topic, locale).then((next) => {
      if (cancelled) return;
      if (next) setLoaded({ key, data: next });
      else setFailed(true);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [key, section, topic, locale]);

  useEffect(() => {
    if (data) onReady?.(key);
  }, [data, key, onReady]);

  if (!data) {
    if (deferUntilReady) return null;
    return (
      <div className="mx-auto flex min-h-[60vh] max-w-[1100px] items-center px-4 py-8 sm:px-5" role={loading ? 'status' : 'alert'}>
        <div className="w-full rounded-2xl border border-edge bg-surface p-6 text-sm text-subtle shadow-sm">
          {loading ? copy.loading : (failed ? copy.unavailable : copy.loading)}
        </div>
      </div>
    );
  }

  const config = cantonSectionConfig(section);
  if (!config) return null;
  const hubLabel = cantonTopicHubLabel(section, topic, locale);
  const sectionLabel = cantonSectionLabel(section, locale);
  const landingPath = cantonSectionLandingPath(section, locale);
  const copyTopics = Object.keys(config.topicHubs ?? {}).filter((candidate) => candidate !== topic);
  const archive = cantonArchiveCopy(section, locale);
  const paragraphs = data.intro.split(/\n\s*\n/).map((paragraph) => paragraph.trim()).filter(Boolean);

  return (
    <article data-canton-topic-hub={`${section}:${topic}`} className="mx-auto min-w-0 max-w-[1100px] px-4 py-6 sm:px-5 sm:py-8">
      <nav aria-label={{ it: 'Percorso di navigazione', en: 'Breadcrumb', de: 'Brotkrümelnavigation', fr: 'Fil d’Ariane' }[locale]} className="mb-4 text-sm text-subtle">
        <a href="/" className="text-accent hover:underline">Home</a>
        <span aria-hidden="true" className="px-2">/</span>
        <a href={landingPath} className="text-accent hover:underline">{sectionLabel}</a>
        <span aria-hidden="true" className="px-2">/</span>
        <span aria-current="page">{hubLabel}</span>
      </nav>

      <header className="mb-6">
        <h1 className="text-3xl font-extrabold leading-tight text-heading sm:text-4xl">{hubLabel}</h1>
        {paragraphs.map((paragraph, index) => (
          <p key={`${key}-intro-${index}`} className={`mt-3 max-w-4xl leading-7 ${index === 0 ? 'text-base text-body' : 'text-sm text-subtle'}`}>
            {paragraph}
          </p>
        ))}
        <p className="mt-4 text-sm text-subtle">
          {copy.updated}{' '}
          <time dateTime={data.updatedAt}>{formatDate(data.updatedAt, locale)}</time>
        </p>
      </header>

      {data.keyFacts.length > 0 ? (
        <section aria-label={copy.keyFacts} className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {data.keyFacts.map((fact, index) => (
            <div key={`${key}-fact-${index}`} className="rounded-2xl border border-edge bg-surface p-4 shadow-sm">
              <div className="text-sm text-subtle">{fact.label}</div>
              <div className="mt-1 text-2xl font-extrabold font-display text-heading">{fact.value}</div>
              {fact.note ? <div className="mt-1 text-xs leading-5 text-muted">{fact.note}</div> : null}
              <SourceLine copy={copy} name={fact.sourceName} url={fact.sourceUrl} />
            </div>
          ))}
        </section>
      ) : null}

      <div className="space-y-7">
        {data.dataBlocks.map((block) => <DataBlock key={block.id} block={block} locale={locale} copy={copy} />)}
      </div>

      <section aria-labelledby="hub-articles" className="mt-8 border-t border-edge pt-6">
        <h2 id="hub-articles" className="text-xl font-bold font-display text-heading">{copy.curated}</h2>
        {data.curatedArticles.length > 0 ? (
          <ul className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
            {data.curatedArticles.map((article, index) => (
              <li key={`${key}-article-${index}`} className="rounded-xl border border-edge bg-surface p-4 shadow-sm">
                <a href={article.url} className="font-semibold text-accent hover:underline">{article.title}</a>
                {article.excerpt ? <p className="mt-2 text-sm leading-6 text-subtle">{article.excerpt}</p> : null}
                {article.date ? <time className="mt-2 block text-xs text-muted" dateTime={article.date}>{formatDate(article.date, locale)}</time> : null}
              </li>
            ))}
          </ul>
        ) : <p className="mt-3 text-sm leading-6 text-subtle">{copy.noCurated}</p>}
      </section>

      {data.links.length > 0 ? (
        <section aria-labelledby="hub-tools" className="mt-8 border-t border-edge pt-6">
          <h2 id="hub-tools" className="text-xl font-bold font-display text-heading">{copy.tools}</h2>
          <ul className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {data.links.map((link, index) => (
              <li key={`${key}-link-${index}`} className="rounded-xl border border-edge/70 bg-surface-alt/35 px-3 py-3 text-sm leading-6">
                <a href={link.url} className="font-semibold text-accent hover:underline">{link.label}</a>
                {link.description ? <span className="text-subtle"> — {link.description}</span> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <nav aria-label={copy.otherTopics} className="mt-8 border-t border-edge pt-6">
        <h2 className="text-xl font-bold font-display text-heading">{copy.otherTopics}</h2>
        <ul className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {copyTopics.map((candidate) => (
            <li key={candidate}>
              <a href={cantonTopicHubPath(section, candidate, locale)} className="block rounded-xl border border-edge bg-surface px-3 py-3 text-sm font-semibold text-accent hover:border-accent hover:underline">
                {cantonTopicHubLabel(section, candidate, locale)}
              </a>
            </li>
          ))}
          <li><a href={landingPath} className="block rounded-xl border border-edge bg-surface px-3 py-3 text-sm font-semibold text-accent hover:border-accent hover:underline">{sectionLabel}</a></li>
          <li><a href={cantonSectionArchivePath(section, locale)} className="block rounded-xl border border-edge bg-surface px-3 py-3 text-sm font-semibold text-accent hover:border-accent hover:underline">{archive.title}</a></li>
        </ul>
      </nav>
    </article>
  );
}

export default CantonTopicHub;
