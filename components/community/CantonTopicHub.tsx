import { Fragment, Suspense, useEffect, useState, type CSSProperties } from 'react';
import { lazyRetry } from '@/services/lazyRetry';
import { useLocale } from '@/services/i18n';
import { AD_SLOTS } from '@/services/adsenseSlots';
import type { CantonArticleSection } from '@/services/articleSections';
import {
  cantonArchiveCopy,
  cantonLatestNewsHeading,
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

const AdSenseBanner = lazyRetry(() => import('@/components/shared/AdSenseBanner'));
const ArticleRailAdStack = lazyRetry(() => import('@/components/shared/ArticleRailAdStack'));

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
  advertisement: string;
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
    advertisement: 'Pubblicità',
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
    advertisement: 'Advertisement',
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
    advertisement: 'Werbung',
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
    advertisement: 'Publicité',
  },
};

type CantonHubAdSlot =
  | 'JOBDETAIL_TOP_BANNER'
  | 'ARTICLE_INLINE_MOBILE'
  | 'ARTICLE_INLINE_MOBILE_2'
  | 'SSG_END_MULTIPLEX';

function HubAd({
  slot,
  label,
  className,
}: {
  slot: CantonHubAdSlot;
  label: string;
  className?: string;
}) {
  const config = AD_SLOTS[slot];
  const layout = 'layout' in config ? config.layout : undefined;
  return (
    <section className={`cth-ad ${className ?? ''}`.trim()} aria-label={label}>
      <p className="cth-ad-label">{label}</p>
      <Suspense fallback={<div className="cth-ad-placeholder" style={{ minHeight: config.placeholderMinHeight }} aria-hidden="true" />}>
        <AdSenseBanner
          adSlot={config.slot}
          adFormat={config.format}
          adLayout={layout}
          fullWidthResponsive={config.fullWidthResponsive}
          placement={`canton-hub-${slot.toLowerCase()}`}
          className="cth-ad-slot"
        />
      </Suspense>
    </section>
  );
}

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
    <p className="cth-source-line mt-3 text-sm text-subtle">
      {copy.source}:{' '}
      {url ? <a href={url} rel="noopener" className="text-accent hover:underline">{name}</a> : name}
    </p>
  );
}

function DataItem({ item, locale }: { item: CantonHubDataItem; locale: keyof typeof HUB_COPY }) {
  return (
    <li className="cth-data-item min-w-0 text-sm leading-6">
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
    <section aria-labelledby={headingId} className="cth-section cth-data-block">
      <div className="cth-section-heading"><h2 id={headingId} className="cth-section-title">{block.title}</h2><span className="cth-section-marker" aria-hidden="true" /></div>
      {block.description ? <p className="cth-section-intro">{block.description}</p> : null}
      {block.items.length > 0 ? (
        <ul className="cth-data-list" aria-label={block.title}>
          {block.items.map((item, index) => <DataItem key={`${block.id}-${index}`} item={item} locale={locale} />)}
        </ul>
      ) : null}
      {block.updatedAt ? (
        <p className="cth-source-line mt-3 text-sm text-subtle">
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
  const [collapsedRails, setCollapsedRails] = useState({ left: false, right: false });

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
  const railStyle: CSSProperties = {
    ...(collapsedRails.left ? { '--cth-rail-left': '0px' } : {}),
    ...(collapsedRails.right ? { '--cth-rail-right': '0px' } : {}),
  } as CSSProperties;
  const handleRailEmpty = (side: 'left' | 'right') => (allEmpty: boolean) => {
    setCollapsedRails((current) => current[side] === allEmpty ? current : { ...current, [side]: allEmpty });
  };

  return (
    <div data-canton-topic-hub={`${section}:${topic}`} className="cth-react-rail-grid" style={railStyle}>
      <aside className="cth-react-rail" aria-label={copy.advertisement}>
        <Suspense fallback={null}><ArticleRailAdStack side="left" desktopRail onEmptyResolved={handleRailEmpty('left')} /></Suspense>
      </aside>

      <div className="cth-react-center">
        <article className="cth-page cth-react-page min-w-0">
          <nav aria-label={{ it: 'Percorso di navigazione', en: 'Breadcrumb', de: 'Brotkrümelnavigation', fr: 'Fil d’Ariane' }[locale]} className="s-AxRVCF">
            <a href="/" className="s-wfUMYx">Home</a>
            <span aria-hidden="true"> / </span>
            <a href={landingPath} className="s-wfUMYx">{sectionLabel}</a>
            <span aria-hidden="true"> / </span>
            <span aria-current="page">{hubLabel}</span>
          </nav>

          <header className="cth-hero cth-hero-hub">
            <div className="cth-hero-copy">
              <h1 className="s-e3gkVi">{hubLabel}</h1>
              {paragraphs.map((paragraph, index) => (
                <p key={`${key}-intro-${index}`} className={index === 0 ? 's-OPPwy-' : undefined}>{paragraph}</p>
              ))}
              <p className="cth-hero-meta"><span>{copy.updated}</span><time dateTime={data.updatedAt}>{formatDate(data.updatedAt, locale)}</time></p>
            </div>
            <aside className="cth-hero-index" aria-label={copy.otherTopics}>
              <h2>{copy.otherTopics}</h2>
              <ul>
                {copyTopics.slice(0, 4).map((candidate) => (
                  <li key={`${key}-hero-topic-${candidate}`}><a href={cantonTopicHubPath(section, candidate, locale)}>{cantonTopicHubLabel(section, candidate, locale)}<span aria-hidden="true">↗</span></a></li>
                ))}
              </ul>
            </aside>
          </header>

          <HubAd slot="JOBDETAIL_TOP_BANNER" label={copy.advertisement} className="cth-ad-top" />

          {data.keyFacts.length > 0 ? (
            <section aria-labelledby="hub-facts" className="cth-facts">
              <div className="cth-section-heading"><h2 id="hub-facts" className="cth-section-title">{copy.keyFacts}</h2></div>
              <div className="cth-facts-grid">
                {data.keyFacts.map((fact, index) => (
                  <div key={`${key}-fact-${index}`} className={`cth-fact${index === 0 ? ' cth-fact-featured' : ''}`}>
                    <div className="cth-fact-label">{fact.label}</div>
                    <div className="s-tval">{fact.value}</div>
                    {fact.note ? <div className="cth-fact-note">{fact.note}</div> : null}
                    <SourceLine copy={copy} name={fact.sourceName} url={fact.sourceUrl} />
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          {data.dataBlocks.map((block, index) => (
            <Fragment key={block.id}>
              <DataBlock block={block} locale={locale} copy={copy} />
              {index === 0 ? <HubAd slot="ARTICLE_INLINE_MOBILE" label={copy.advertisement} className="cth-ad-inline cth-ad-inline-one" /> : null}
            </Fragment>
          ))}

          {data.dataBlocks.length > 0 ? <HubAd slot="ARTICLE_INLINE_MOBILE_2" label={copy.advertisement} className="cth-ad-inline cth-ad-inline-two" /> : null}

          <section aria-labelledby="hub-articles" className="cth-section cth-curated">
            <div className="cth-section-heading"><h2 id="hub-articles" className="cth-section-title">{copy.curated}</h2><span className="cth-section-marker" aria-hidden="true" /></div>
            {data.curatedArticles.length > 0 ? (
              <ul className="cth-article-list">
                {data.curatedArticles.map((article, index) => (
                  <li key={`${key}-article-${index}`}>
                    <a href={article.url}>
                      <span className="s-lkdl0F">{article.title}</span>
                      {article.excerpt ? <span className="s-hNvHD_">{article.excerpt}</span> : null}
                      {article.date ? <time className="cth-source-line" dateTime={article.date}>{formatDate(article.date, locale)}</time> : null}
                    </a>
                  </li>
                ))}
              </ul>
            ) : <p className="cth-section-intro">{copy.noCurated}</p>}
          </section>

          {data.curatedArticles.length === 0 && data.latestCantonArticles.length > 0 ? (
            <section aria-labelledby="hub-latest-news" className="cth-section cth-latest-news">
              <div className="cth-section-heading"><h2 id="hub-latest-news" className="s-sXAwQz cth-section-title">{cantonLatestNewsHeading(section, locale)}</h2><span className="cth-section-marker" aria-hidden="true" /></div>
              <ul className="s-0c2lhY cth-article-list">
                {data.latestCantonArticles.map((article, index) => (
                  <li key={`${key}-latest-article-${index}`}>
                    <a className="s-6gbS_B" href={article.url}>
                      <span className="s-lkdl0F">{article.title}</span>
                      {article.excerpt ? <span className="s-hNvHD_">{article.excerpt}</span> : null}
                      {article.date ? <time className="cth-source-line" dateTime={article.date}>{formatDate(article.date, locale)}</time> : null}
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {data.links.length > 0 ? (
            <section aria-labelledby="hub-tools" className="cth-section cth-tools">
              <div className="cth-section-heading"><h2 id="hub-tools" className="cth-section-title">{copy.tools}</h2><span className="cth-section-marker" aria-hidden="true" /></div>
              <ul className="cth-data-list">
                {data.links.map((link, index) => (
                  <li key={`${key}-link-${index}`}><span><a href={link.url}>{link.label}</a>{link.description ? <span> — {link.description}</span> : null}</span></li>
                ))}
              </ul>
            </section>
          ) : null}

          <nav aria-label={copy.otherTopics} className="cth-topic-nav">
            <h2 className="cth-section-title">{copy.otherTopics}</h2>
            <ul className="cth-topic-list">
              {copyTopics.map((candidate) => (
                <li key={candidate}><a href={cantonTopicHubPath(section, candidate, locale)}>{cantonTopicHubLabel(section, candidate, locale)}</a></li>
              ))}
              <li><a href={landingPath}>{sectionLabel}</a></li>
              <li><a href={cantonSectionArchivePath(section, locale)}>{archive.title}</a></li>
            </ul>
          </nav>

          <HubAd slot="SSG_END_MULTIPLEX" label={copy.advertisement} className="cth-ad-bottom" />
        </article>
      </div>

      <aside className="cth-react-rail" aria-label={copy.advertisement}>
        <Suspense fallback={null}><ArticleRailAdStack side="right" desktopRail onEmptyResolved={handleRailEmpty('right')} /></Suspense>
      </aside>
    </div>
  );
}

export default CantonTopicHub;
