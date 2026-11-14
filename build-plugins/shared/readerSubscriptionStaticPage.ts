import type { ReaderSubscriptionLocale } from '../../services/readerSubscriptionPath';

const PAGE_META: Record<ReaderSubscriptionLocale, { title: string; description: string }> = {
  it: {
    title: 'Abbonamento lettori | Frontaliereticino.ch',
    description: 'Naviga su Frontaliereticino.ch senza pubblicità con l’abbonamento lettori.',
  },
  en: {
    title: 'Reader subscription | Frontaliereticino.ch',
    description: 'Browse Frontaliereticino.ch without ads with the reader subscription.',
  },
  de: {
    title: 'Leser-Abo | Frontaliereticino.ch',
    description: 'Nutzen Sie Frontaliereticino.ch mit dem Leser-Abo ohne Werbung.',
  },
  fr: {
    title: 'Abonnement lecteur | Frontaliereticino.ch',
    description: 'Naviguez sur Frontaliereticino.ch sans publicité avec l’abonnement lecteur.',
  },
};

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/**
 * Minimal noindex SPA shell for the existing reader subscription route.
 * It carries the normal AdSense bootstrap so anonymous visitors can see Auto
 * Ads; the shared loader still suppresses ads for active reader entitlements
 * and excludes this route from house-ad recovery.
 */
export function renderReaderSubscriptionStaticPage(input: {
  locale: ReaderSubscriptionLocale;
  canonicalUrl: string;
  headPrefix: string;
  adsenseBootstrap: string;
  cssHead: string;
  rootShell: string;
  entryJs: string;
}): string {
  const meta = PAGE_META[input.locale];
  const title = escapeAttribute(meta.title);
  const description = escapeAttribute(meta.description);
  const canonicalUrl = escapeAttribute(input.canonicalUrl);
  const entryJs = escapeAttribute(input.entryJs);
  return `<!doctype html>
<html lang="${input.locale}">
  <head>
    ${input.headPrefix}
    <title>${title}</title>
    <meta name="description" content="${description}">
    <meta name="robots" content="noindex,follow">
    <link rel="canonical" href="${canonicalUrl}">
    <meta property="og:type" content="website">
    <meta property="og:title" content="${title}">
    <meta property="og:description" content="${description}">
    <meta property="og:url" content="${canonicalUrl}">
    ${input.adsenseBootstrap}
    ${input.cssHead}
  </head>
  <body class="bg-surface-alt text-heading overflow-x-hidden">
    ${input.rootShell}
    <div id="modal-root"></div>
    <script type="module" crossorigin src="/assets/${entryJs}"></script>
  </body>
</html>`;
}
