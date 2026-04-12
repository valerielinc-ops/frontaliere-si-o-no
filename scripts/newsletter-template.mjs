/**
 * newsletter-template.mjs — HTML email template for Frontaliere Ticino weekly newsletter
 *
 * Generates a responsive single-column HTML email with inline styles.
 * Each section is optional and can be individually toggled.
 * Supports 4 locales: it, en, de, fr.
 *
 * Usage: import { buildNewsletter } from './newsletter-template.mjs';
 *   const html = buildNewsletter({ exchangeRate, topArticles, weeklyFact, latestArticle, featuredTool, unsubscribeUrl, locale });
 */

const BASE_URL = 'https://frontaliereticino.ch';
const BRAND_BLUE = '#2563EB';
const BRAND_DARK = '#0f172a';
const LIGHT_BG = '#f3f4f6';
const CARD_BG = '#ffffff';
const TEXT_COLOR = '#1f2937';
const MUTED_COLOR = '#6b7280';
const BORDER_COLOR = '#dbe2ea';

// ─── i18n for newsletter template ─────────────────────────────
const NL_TRANSLATIONS = {
  it: {
    weeklyTag: 'Frontaliere Weekly',
    heroTitle: 'Le cose utili della settimana, senza rumore.',
    heroSubtitle: 'Cambio CHF/EUR, guide pratiche e un solo strumento da aprire subito.',
    heroBullet2: 'Una guida utile da leggere in 3 minuti',
    heroBullet3: 'Un tool pratico da aprire ora',
    heroCta: 'Apri le offerte di oggi',
    exchangeLabel: 'Cambio della settimana',
    exchangeVs: 'vs settimana scorsa',
    exchangePrev: 'Settimana scorsa',
    exchangeCta: 'Vedi storico cambio',
    outlookLabel: 'Cosa conviene fare',
    outlookMonthCurrent: 'Media mese corrente',
    outlookMonthPrev: 'Media mese precedente',
    outlookBestDay: 'Miglior giorno medio',
    outlookProviderLabel: 'Provider più convenienti su 1.000 CHF',
    outlookCta: 'Confronta provider',
    articlesLabel: 'Guide da aprire questa settimana',
    articleReads: 'letture',
    articleMin: 'min',
    articlesCta: 'Vedi tutte le guide',
    factLabel: 'Numero utile da sapere',
    factSource: 'Fonte',
    latestLabel: 'Approfondimento della settimana',
    latestCta: 'Apri la guida',
    toolLabel: 'Strumento da aprire subito',
    footerReason: 'Ricevi questa email perché hai lasciato il tuo indirizzo su Frontaliere Ticino.',
    footerUnsub: 'Disiscriviti',
    footerResub: 'Riattiva iscrizione',
    footerPrivacy: 'Privacy',
    affiliateLabel: 'Risorse utili per frontalieri',
    affiliateDisclosure: 'Link sponsorizzati — potremmo ricevere una commissione',
    preheaderDefault: 'Cambio, lavoro e guide utili per frontalieri',
    preheaderRate: 'Cambio, guida utile e offerte di oggi',
    schemaDesc: 'Cambio CHF/EUR, offerte di lavoro e una guida utile per frontalieri.',
    schemaCta: 'Apri offerte di oggi',
  },
  en: {
    weeklyTag: 'Frontaliere Weekly',
    heroTitle: 'This week\'s essentials, no noise.',
    heroSubtitle: 'CHF/EUR rate, practical guides and one tool to open right away.',
    heroBullet2: 'A useful guide to read in 3 minutes',
    heroBullet3: 'A practical tool to open now',
    heroCta: 'Open today\'s job offers',
    exchangeLabel: 'Exchange rate of the week',
    exchangeVs: 'vs last week',
    exchangePrev: 'Last week',
    exchangeCta: 'View rate history',
    outlookLabel: 'What to do',
    outlookMonthCurrent: 'Current month average',
    outlookMonthPrev: 'Previous month average',
    outlookBestDay: 'Best average day',
    outlookProviderLabel: 'Best providers for 1,000 CHF',
    outlookCta: 'Compare providers',
    articlesLabel: 'Guides to read this week',
    articleReads: 'reads',
    articleMin: 'min',
    articlesCta: 'View all guides',
    factLabel: 'Useful number to know',
    factSource: 'Source',
    latestLabel: 'Deep dive of the week',
    latestCta: 'Read the guide',
    toolLabel: 'Tool to try now',
    footerReason: 'You receive this email because you subscribed on Frontaliere Ticino.',
    footerUnsub: 'Unsubscribe',
    footerResub: 'Resubscribe',
    footerPrivacy: 'Privacy',
    affiliateLabel: 'Useful resources for cross-border workers',
    affiliateDisclosure: 'Sponsored links — we may earn a commission',
    preheaderDefault: 'Rates, jobs and useful guides for cross-border workers',
    preheaderRate: 'Rates, guide and today\'s offers',
    schemaDesc: 'CHF/EUR rate, job offers and a useful guide for cross-border workers.',
    schemaCta: 'Open today\'s offers',
  },
  de: {
    weeklyTag: 'Frontaliere Weekly',
    heroTitle: 'Das Wichtigste der Woche, ohne Lärm.',
    heroSubtitle: 'CHF/EUR-Kurs, praktische Ratgeber und ein Tool zum Ausprobieren.',
    heroBullet2: 'Ein nützlicher Ratgeber in 3 Minuten',
    heroBullet3: 'Ein praktisches Tool zum Öffnen',
    heroCta: 'Stellenangebote öffnen',
    exchangeLabel: 'Wechselkurs der Woche',
    exchangeVs: 'vs letzte Woche',
    exchangePrev: 'Letzte Woche',
    exchangeCta: 'Kursverlauf anzeigen',
    outlookLabel: 'Was sich lohnt',
    outlookMonthCurrent: 'Durchschnitt aktueller Monat',
    outlookMonthPrev: 'Durchschnitt Vormonat',
    outlookBestDay: 'Bester Durchschnittstag',
    outlookProviderLabel: 'Beste Anbieter für 1.000 CHF',
    outlookCta: 'Anbieter vergleichen',
    articlesLabel: 'Ratgeber dieser Woche',
    articleReads: 'Aufrufe',
    articleMin: 'Min',
    articlesCta: 'Alle Ratgeber anzeigen',
    factLabel: 'Nützliche Zahl der Woche',
    factSource: 'Quelle',
    latestLabel: 'Vertiefung der Woche',
    latestCta: 'Ratgeber öffnen',
    toolLabel: 'Tool der Woche',
    footerReason: 'Sie erhalten diese E-Mail, weil Sie sich auf Frontaliere Ticino angemeldet haben.',
    footerUnsub: 'Abmelden',
    footerResub: 'Erneut anmelden',
    footerPrivacy: 'Datenschutz',
    affiliateLabel: 'Nützliche Ressourcen für Grenzgänger',
    affiliateDisclosure: 'Gesponserte Links — wir erhalten möglicherweise eine Provision',
    preheaderDefault: 'Kurse, Stellen und nützliche Ratgeber für Grenzgänger',
    preheaderRate: 'Kurs, Ratgeber und aktuelle Angebote',
    schemaDesc: 'CHF/EUR-Kurs, Stellenangebote und ein nützlicher Ratgeber für Grenzgänger.',
    schemaCta: 'Aktuelle Angebote öffnen',
  },
  fr: {
    weeklyTag: 'Frontaliere Weekly',
    heroTitle: 'L\'essentiel de la semaine, sans bruit.',
    heroSubtitle: 'Taux CHF/EUR, guides pratiques et un outil à ouvrir tout de suite.',
    heroBullet2: 'Un guide utile à lire en 3 minutes',
    heroBullet3: 'Un outil pratique à ouvrir maintenant',
    heroCta: 'Voir les offres du jour',
    exchangeLabel: 'Taux de change de la semaine',
    exchangeVs: 'vs semaine dernière',
    exchangePrev: 'Semaine dernière',
    exchangeCta: 'Voir l\'historique',
    outlookLabel: 'Que faire',
    outlookMonthCurrent: 'Moyenne mois en cours',
    outlookMonthPrev: 'Moyenne mois précédent',
    outlookBestDay: 'Meilleur jour moyen',
    outlookProviderLabel: 'Meilleurs fournisseurs pour 1 000 CHF',
    outlookCta: 'Comparer les fournisseurs',
    articlesLabel: 'Guides à lire cette semaine',
    articleReads: 'lectures',
    articleMin: 'min',
    articlesCta: 'Voir tous les guides',
    factLabel: 'Chiffre utile à connaître',
    factSource: 'Source',
    latestLabel: 'Approfondissement de la semaine',
    latestCta: 'Lire le guide',
    toolLabel: 'Outil à essayer maintenant',
    footerReason: 'Vous recevez cet e-mail car vous vous êtes inscrit sur Frontaliere Ticino.',
    footerUnsub: 'Se désinscrire',
    footerResub: 'Se réinscrire',
    footerPrivacy: 'Confidentialité',
    affiliateLabel: 'Ressources utiles pour frontaliers',
    affiliateDisclosure: 'Liens sponsorisés — nous pouvons recevoir une commission',
    preheaderDefault: 'Taux, emplois et guides utiles pour frontaliers',
    preheaderRate: 'Taux, guide et offres du jour',
    schemaDesc: 'Taux CHF/EUR, offres d\'emploi et un guide utile pour frontaliers.',
    schemaCta: 'Voir les offres du jour',
  },
};

const FEATURED_TOOLS_I18N = {
  it: [
    { title: 'Calcola il tuo Credito d\'Imposta', description: 'Scopri quanto risparmi evitando la doppia tassazione in 2 minuti.', buttonText: 'Provalo Gratis', toolUrl: '/tasse-e-pensione/credito-imposta' },
    { title: 'Pianifica la tua Pensione', description: 'Simula la tua rendita AVS + LPP e scopri il gap pensionistico.', buttonText: 'Calcola Ora', toolUrl: '/tasse-e-pensione/calcola-previdenza' },
    { title: 'Confronta le Casse Malati', description: 'Trova la cassa malati più conveniente per la tua situazione.', buttonText: 'Confronta', toolUrl: '/compara-servizi/confronta-casse-malati' },
    { title: 'Simula la Busta Paga', description: 'Visualizza le trattenute sociali e l\'imposta alla fonte mese per mese.', buttonText: 'Simula', toolUrl: '/calcola-stipendio/simula-busta-paga' },
    { title: 'Calcola il Costo dell\'Auto', description: 'Quanto costa davvero il pendolarismo in auto? Benzina, autostrada, usura...', buttonText: 'Calcola', toolUrl: '/guida-frontaliere/costo-auto-pendolare' },
    { title: 'Simulatore 3° Pilastro', description: 'Quanto risparmierai investendo nel terzo pilastro 3a? Proiettalo a 30 anni.', buttonText: 'Simula', toolUrl: '/tasse-e-pensione/simula-terzo-pilastro' },
  ],
  en: [
    { title: 'Calculate your Tax Credit', description: 'Find out how much you save by avoiding double taxation in 2 minutes.', buttonText: 'Try Free', toolUrl: '/tasse-e-pensione/credito-imposta' },
    { title: 'Plan your Pension', description: 'Simulate your AVS + LPP pension and discover your retirement gap.', buttonText: 'Calculate Now', toolUrl: '/tasse-e-pensione/calcola-previdenza' },
    { title: 'Compare Health Insurers', description: 'Find the best LAMal health insurer for your situation.', buttonText: 'Compare', toolUrl: '/compara-servizi/confronta-casse-malati' },
    { title: 'Simulate your Payslip', description: 'View social deductions and withholding tax month by month.', buttonText: 'Simulate', toolUrl: '/calcola-stipendio/simula-busta-paga' },
    { title: 'Calculate Car Commute Cost', description: 'How much does commuting by car really cost? Gas, highway, wear...', buttonText: 'Calculate', toolUrl: '/guida-frontaliere/costo-auto-pendolare' },
    { title: '3rd Pillar Simulator', description: 'How much will you save investing in the 3a pillar? Project over 30 years.', buttonText: 'Simulate', toolUrl: '/tasse-e-pensione/simula-terzo-pilastro' },
  ],
  de: [
    { title: 'Steuerkredit berechnen', description: 'Entdecken Sie, wie viel Sie durch Vermeidung der Doppelbesteuerung sparen.', buttonText: 'Jetzt testen', toolUrl: '/tasse-e-pensione/credito-imposta' },
    { title: 'Pension planen', description: 'Simulieren Sie Ihre AVS + BVG-Rente und entdecken Sie Ihre Vorsorgelücke.', buttonText: 'Jetzt berechnen', toolUrl: '/tasse-e-pensione/calcola-previdenza' },
    { title: 'Krankenkassen vergleichen', description: 'Finden Sie die günstigste LAMal-Krankenkasse für Ihre Situation.', buttonText: 'Vergleichen', toolUrl: '/compara-servizi/confronta-casse-malati' },
    { title: 'Lohnabrechnung simulieren', description: 'Sehen Sie Sozialabzüge und Quellensteuer Monat für Monat.', buttonText: 'Simulieren', toolUrl: '/calcola-stipendio/simula-busta-paga' },
    { title: 'Autopendlerkosten berechnen', description: 'Was kostet das Pendeln mit dem Auto wirklich?', buttonText: 'Berechnen', toolUrl: '/guida-frontaliere/costo-auto-pendolare' },
    { title: '3. Säule Simulator', description: 'Wie viel sparen Sie durch Investitionen in die Säule 3a?', buttonText: 'Simulieren', toolUrl: '/tasse-e-pensione/simula-terzo-pilastro' },
  ],
  fr: [
    { title: 'Calculez votre Crédit d\'Impôt', description: 'Découvrez combien vous économisez en évitant la double imposition.', buttonText: 'Essayer gratuitement', toolUrl: '/tasse-e-pensione/credito-imposta' },
    { title: 'Planifiez votre Retraite', description: 'Simulez votre rente AVS + LPP et découvrez votre écart de prévoyance.', buttonText: 'Calculer', toolUrl: '/tasse-e-pensione/calcola-previdenza' },
    { title: 'Comparez les Caisses Maladie', description: 'Trouvez la caisse maladie LAMal la plus avantageuse pour votre situation.', buttonText: 'Comparer', toolUrl: '/compara-servizi/confronta-casse-malati' },
    { title: 'Simulez votre Fiche de Paie', description: 'Visualisez les déductions sociales et l\'impôt à la source mois par mois.', buttonText: 'Simuler', toolUrl: '/calcola-stipendio/simula-busta-paga' },
    { title: 'Calculez le Coût Auto', description: 'Combien coûte vraiment le pendulaire en voiture ?', buttonText: 'Calculer', toolUrl: '/guida-frontaliere/costo-auto-pendolare' },
    { title: 'Simulateur 3e Pilier', description: 'Combien économiserez-vous en investissant dans le 3e pilier 3a ?', buttonText: 'Simuler', toolUrl: '/tasse-e-pensione/simula-terzo-pilastro' },
  ],
};

function nlNormLocale(raw) {
  if (!raw) return 'it';
  const lang = String(raw).toLowerCase().split(/[-_]/)[0];
  if (lang === 'en' || lang === 'de' || lang === 'fr') return lang;
  return 'it';
}

function nlT(locale, key) {
  const lang = nlNormLocale(locale);
  return NL_TRANSLATIONS[lang]?.[key] || NL_TRANSLATIONS.it[key] || key;
}

function utmUrl(path, campaign) {
  const sep = path.includes('?') ? '&' : '?';
  return `${BASE_URL}${path}${sep}utm_source=newsletter&utm_medium=email&utm_campaign=${campaign}`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderEmailActionMarkup({ campaign, locale }) {
  const targetUrl = utmUrl('/cerca-lavoro-ticino/offerte-di-lavoro-ticino-oggi/', campaign);
  const logoUrl = `${BASE_URL}/og-image.png`;
  return `<script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'EmailMessage',
    description: nlT(locale, 'schemaDesc'),
    publisher: {
      '@type': 'Organization',
      name: 'Frontaliere Ticino',
      url: BASE_URL,
      logo: logoUrl,
    },
    potentialAction: {
      '@type': 'ViewAction',
      url: targetUrl,
      name: nlT(locale, 'schemaCta'),
    },
  })}</script>`;
}

function renderHero({ campaign, exchangeRate, locale }) {
  const quickRate = exchangeRate ? `CHF/EUR ${exchangeRate.rate.toFixed(4)}` : nlT(locale, 'weeklyTag');
  return `
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:18px;">
      <tr>
        <td style="background:${CARD_BG};border:1px solid ${BORDER_COLOR};border-radius:16px;padding:22px 20px;">
          <div style="font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:${BRAND_BLUE};font-weight:700;padding-bottom:8px;">${nlT(locale, 'weeklyTag')}</div>
          <div style="font-size:28px;line-height:1.15;font-weight:800;color:${BRAND_DARK};padding-bottom:8px;">${nlT(locale, 'heroTitle')}</div>
          <div style="font-size:15px;line-height:1.55;color:${TEXT_COLOR};padding-bottom:14px;">${nlT(locale, 'heroSubtitle')}</div>
          <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:14px;">
            <tr><td style="font-size:13px;color:${TEXT_COLOR};padding:0 0 8px;">• ${quickRate}</td></tr>
            <tr><td style="font-size:13px;color:${TEXT_COLOR};padding:0 0 8px;">• ${nlT(locale, 'heroBullet2')}</td></tr>
            <tr><td style="font-size:13px;color:${TEXT_COLOR};">• ${nlT(locale, 'heroBullet3')}</td></tr>
          </table>
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr><td align="left">
              <a href="${utmUrl('/cerca-lavoro-ticino/offerte-di-lavoro-ticino-oggi/', campaign)}" style="display:inline-block;background:${BRAND_BLUE};color:#ffffff;text-decoration:none;padding:13px 18px;border-radius:12px;font-size:15px;font-weight:700;">${nlT(locale, 'heroCta')}</a>
            </td></tr>
          </table>
        </td>
      </tr>
    </table>`;
}

// ─── Section renderers ───────────────────────────────────────

function renderExchangeRate({ rate, previousRate, campaign, locale }) {
  const diff = rate - previousRate;
  const pct = previousRate > 0 ? ((diff / previousRate) * 100).toFixed(2) : '0.00';
  const arrow = diff > 0.0005 ? '▲' : diff < -0.0005 ? '▼' : '●';
  const arrowColor = diff > 0.0005 ? '#16a34a' : diff < -0.0005 ? '#dc2626' : MUTED_COLOR;
  const sign = diff > 0 ? '+' : '';

  return `
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
      <tr><td style="background:${CARD_BG};border:1px solid ${BORDER_COLOR};border-radius:16px;padding:20px;">
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td style="font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:${MUTED_COLOR};padding-bottom:8px;font-weight:700;">${nlT(locale, 'exchangeLabel')}</td>
          </tr>
          <tr>
            <td style="font-size:34px;font-weight:800;color:${BRAND_DARK};padding-bottom:6px;">
              1 CHF = ${rate.toFixed(4)} EUR
            </td>
          </tr>
          <tr>
            <td style="font-size:14px;color:${arrowColor};font-weight:600;">
              ${arrow} ${sign}${pct}% ${nlT(locale, 'exchangeVs')}
            </td>
          </tr>
          <tr>
            <td style="font-size:13px;color:${MUTED_COLOR};padding-top:8px;">
              ${nlT(locale, 'exchangePrev')}: 1 CHF = ${previousRate.toFixed(4)} EUR
            </td>
          </tr>
        </table>
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px;">
          <tr><td align="left">
            <a href="${utmUrl('/compara-servizi/cambio-franco-euro', campaign)}" style="display:inline-block;background:${BRAND_BLUE};color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:12px;font-size:15px;font-weight:700;">
              ${nlT(locale, 'exchangeCta')}
            </a>
          </td></tr>
        </table>
      </td></tr>
    </table>`;
}

function renderMarketOutlook({ insight, campaign, locale }) {
  if (!insight) return '';
  const providerRows = (insight.providerRanking || []).slice(0, 3).map((p, i) => `
    <tr>
      <td style="padding:6px 0;font-size:13px;color:${TEXT_COLOR};">${i + 1}. ${escapeHtml(p.name)}</td>
      <td align="right" style="padding:6px 0;font-size:13px;color:${BRAND_DARK};font-weight:600;">${p.netEur.toFixed(2)} EUR</td>
    </tr>
  `).join('');

  return `
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
      <tr><td style="background:${CARD_BG};border:1px solid ${BORDER_COLOR};border-radius:16px;padding:20px;">
        <div style="font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:${MUTED_COLOR};padding-bottom:10px;font-weight:700;">${nlT(locale, 'outlookLabel')}</div>
        <div style="font-size:23px;line-height:1.25;color:${BRAND_DARK};font-weight:800;padding-bottom:6px;">${escapeHtml(insight.headline)}</div>
        <div style="font-size:15px;color:${TEXT_COLOR};line-height:1.6;padding-bottom:14px;">${escapeHtml(insight.summary)}</div>

        <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border:1px solid ${BORDER_COLOR};border-radius:12px;padding:12px;">
          <tr>
            <td style="font-size:13px;color:${MUTED_COLOR};padding-bottom:8px;">${nlT(locale, 'outlookMonthCurrent')}</td>
            <td align="right" style="font-size:13px;color:${BRAND_DARK};font-weight:700;padding-bottom:8px;">${insight.currentMonthAvg.toFixed(4)}</td>
          </tr>
          <tr>
            <td style="font-size:13px;color:${MUTED_COLOR};padding-bottom:8px;">${nlT(locale, 'outlookMonthPrev')}</td>
            <td align="right" style="font-size:13px;color:${BRAND_DARK};font-weight:700;padding-bottom:8px;">${insight.previousMonthAvg.toFixed(4)}</td>
          </tr>
          <tr>
            <td style="font-size:13px;color:${MUTED_COLOR};">${nlT(locale, 'outlookBestDay')}</td>
            <td align="right" style="font-size:13px;color:${BRAND_DARK};font-weight:700;">${escapeHtml(insight.bestWeekday)}</td>
          </tr>
        </table>

        <div style="font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:${MUTED_COLOR};padding:14px 0 8px;font-weight:700;">${nlT(locale, 'outlookProviderLabel')}</div>
        <table width="100%" cellpadding="0" cellspacing="0">${providerRows}</table>

        <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:14px;">
          <tr><td align="left">
            <a href="${utmUrl('/compara-servizi/cambio-franco-euro', campaign)}" style="display:inline-block;background:${BRAND_BLUE};color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:12px;font-size:15px;font-weight:700;">
              ${nlT(locale, 'outlookCta')}
            </a>
          </td></tr>
        </table>
      </td></tr>
    </table>`;
}

function renderTopArticles({ articles, campaign, locale }) {
  if (!articles || articles.length === 0) return '';
  const rows = articles.map((a, i) => `
    <tr>
      <td style="padding:12px 0;${i < articles.length - 1 ? `border-bottom:1px solid ${BORDER_COLOR};` : ''}">
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td style="width:28px;vertical-align:top;font-size:20px;font-weight:bold;color:${BRAND_BLUE};">${i + 1}</td>
            <td style="vertical-align:top;">
              <a href="${utmUrl(a.url, campaign)}" style="font-size:15px;font-weight:600;color:${BRAND_DARK};text-decoration:none;">${escapeHtml(a.title)}</a>
              <div style="font-size:12px;color:${MUTED_COLOR};margin-top:2px;">${a.views} ${nlT(locale, 'articleReads')} · ${a.readingMinutes || 5} ${nlT(locale, 'articleMin')}</div>
            </td>
          </tr>
        </table>
      </td>
    </tr>`).join('');

  return `
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
      <tr><td style="background:${CARD_BG};border:1px solid ${BORDER_COLOR};border-radius:16px;padding:20px;">
        <div style="font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:${MUTED_COLOR};padding-bottom:12px;font-weight:700;">${nlT(locale, 'articlesLabel')}</div>
        <table width="100%" cellpadding="0" cellspacing="0">${rows}</table>
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:14px;">
          <tr><td align="left">
            <a href="${utmUrl('/articoli-frontaliere', campaign)}" style="display:inline-block;color:${BRAND_BLUE};text-decoration:none;font-size:14px;font-weight:700;">${nlT(locale, 'articlesCta')}</a>
          </td></tr>
        </table>
      </td></tr>
    </table>`;
}

function renderWeeklyFact({ text, source, campaign, locale }) {
  return `
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
      <tr><td style="background:#f8fafc;border:1px solid ${BORDER_COLOR};border-radius:16px;padding:18px 20px;">
        <div style="font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:${MUTED_COLOR};padding-bottom:8px;font-weight:700;">${nlT(locale, 'factLabel')}</div>
        <div style="font-size:20px;line-height:1.45;color:${BRAND_DARK};font-weight:700;">${escapeHtml(text)}</div>
        ${source ? `<div style="font-size:12px;color:${MUTED_COLOR};margin-top:8px;">${nlT(locale, 'factSource')}: ${escapeHtml(source)}</div>` : ''}
      </td></tr>
    </table>`;
}

function renderLatestArticle({ title, excerpt, imageUrl, articleUrl, campaign, locale }) {
  return `
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
      <tr><td style="background:${CARD_BG};border:1px solid ${BORDER_COLOR};border-radius:16px;overflow:hidden;">
        <div style="padding:20px;">
          <div style="font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:${MUTED_COLOR};padding-bottom:8px;font-weight:700;">${nlT(locale, 'latestLabel')}</div>
          <div style="font-size:24px;line-height:1.25;font-weight:800;color:${BRAND_DARK};padding-bottom:8px;">${escapeHtml(title)}</div>
          <div style="font-size:15px;color:${TEXT_COLOR};line-height:1.6;padding-bottom:16px;">${escapeHtml(excerpt)}</div>
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr><td align="left">
              <a href="${utmUrl(articleUrl, campaign)}" style="display:inline-block;background:${BRAND_BLUE};color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:12px;font-size:15px;font-weight:700;">
                ${nlT(locale, 'latestCta')}
              </a>
            </td></tr>
          </table>
        </div>
      </td></tr>
    </table>`;
}

function renderFeaturedTool({ title, description, buttonText, toolUrl, campaign, locale }) {
  return `
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
      <tr><td style="background:${CARD_BG};border:1px solid ${BORDER_COLOR};border-radius:16px;padding:20px;">
        <div style="font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:${MUTED_COLOR};padding-bottom:8px;font-weight:700;">${nlT(locale, 'toolLabel')}</div>
        <div style="font-size:24px;line-height:1.25;font-weight:800;color:${BRAND_DARK};padding-bottom:8px;">${escapeHtml(title)}</div>
        <div style="font-size:15px;color:${TEXT_COLOR};line-height:1.6;padding-bottom:16px;">${escapeHtml(description)}</div>
        <a href="${utmUrl(toolUrl, campaign)}" style="display:inline-block;background:${BRAND_BLUE};color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:12px;font-size:15px;font-weight:700;">
          ${escapeHtml(buttonText)}
        </a>
      </td></tr>
    </table>`;
}

// ─── Job section ──────────────────────────────────────────────

const JOB_SECTION_TITLE = {
  it: '💼 Offerte di lavoro in Ticino',
  en: '💼 Job openings in Ticino',
  de: '💼 Stellenangebote im Tessin',
  fr: '💼 Offres d\'emploi au Tessin',
};
const JOB_CTA = {
  it: 'Vedi tutte le offerte →',
  en: 'See all openings →',
  de: 'Alle Stellen ansehen →',
  fr: 'Voir toutes les offres →',
};

function renderJobSection({ jobs, campaign, locale }) {
  if (!jobs || jobs.length === 0) return '';
  const rows = jobs.slice(0, 5).map((j) => {
    const title = esc(String(j.title || '').slice(0, 80));
    const company = esc(String(j.company || ''));
    const location = esc(String(j.location || ''));
    const jobUrl = utmUrl(j.url || `/cerca-lavoro-ticino/${j.slug}/`, campaign);
    return `
      <tr>
        <td style="padding:10px 0;border-bottom:1px solid ${BORDER_COLOR};">
          <a href="${jobUrl}" style="text-decoration:none;">
            <div style="font-size:14px;font-weight:700;color:${BRAND_DARK};line-height:1.3;">${title}</div>
            <div style="font-size:12px;color:${TEXT_COLOR};margin-top:2px;">${company}${location ? ` · ${location}` : ''}</div>
          </a>
        </td>
      </tr>`;
  }).join('');

  return `
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:18px;">
      <tr>
        <td style="background:${CARD_BG};border:1px solid ${BORDER_COLOR};border-radius:16px;padding:20px;">
          <div style="font-size:16px;font-weight:800;color:${BRAND_DARK};padding-bottom:12px;">${JOB_SECTION_TITLE[locale] || JOB_SECTION_TITLE.it}</div>
          <table width="100%" cellpadding="0" cellspacing="0">
            ${rows}
          </table>
          <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:14px;">
            <tr><td align="center">
              <a href="${utmUrl('/cerca-lavoro-ticino/offerte-di-lavoro-ticino-oggi/', campaign)}" style="display:inline-block;background:${BRAND_BLUE};color:#ffffff;text-decoration:none;padding:11px 20px;border-radius:10px;font-size:14px;font-weight:700;">${JOB_CTA[locale] || JOB_CTA.it}</a>
            </td></tr>
          </table>
        </td>
      </tr>
    </table>`;
}

// ─── Affiliate partners section ─────────────────────────────

const AFFILIATE_PARTNERS_NL = [
  { emoji: '💸', name: 'Wise', desc: { it: 'Carta gratuita o zero commissioni fino a CHF 600', en: 'Free card or zero fees up to CHF 600', de: 'Kostenlose Karte oder keine Gebühren bis CHF 600', fr: 'Carte gratuite ou zéro frais jusqu\'à CHF 600' }, goUrl: '/go/wise/' },
  { emoji: '🇮🇹', name: 'Fineco Bank', desc: { it: 'Codice AA8381747 — bonus 50€', en: 'Code AA8381747 — €50 bonus', de: 'Code AA8381747 — 50€ Bonus', fr: 'Code AA8381747 — bonus 50€' }, goUrl: '/go/fineco/' },
  { emoji: '🏦', name: 'Crédit Agricole', desc: { it: 'Buono Amazon 50€ con invito', en: '€50 Amazon voucher with invite', de: '50€ Amazon-Gutschein mit Einladung', fr: 'Bon Amazon 50€ avec invitation' }, goUrl: '/go/creditagricole/' },
];

function renderAffiliatePartners({ campaign, locale }) {
  const rows = AFFILIATE_PARTNERS_NL.map(p => {
    const desc = p.desc[locale] || p.desc.it;
    return `
      <tr>
        <td style="padding:10px 0;border-bottom:1px solid ${BORDER_COLOR};">
          <a href="${utmUrl(p.goUrl, campaign)}" style="text-decoration:none;">
            <div style="font-size:14px;font-weight:700;color:${BRAND_DARK};line-height:1.3;">${p.emoji} ${escapeHtml(p.name)}</div>
            <div style="font-size:12px;color:${TEXT_COLOR};margin-top:2px;">${escapeHtml(desc)}</div>
          </a>
        </td>
      </tr>`;
  }).join('');

  return `
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:18px;">
      <tr><td style="background:${CARD_BG};border:1px solid ${BORDER_COLOR};border-radius:16px;padding:20px;">
        <div style="font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:${MUTED_COLOR};padding-bottom:10px;font-weight:700;">${nlT(locale, 'affiliateLabel')}</div>
        <table width="100%" cellpadding="0" cellspacing="0">
          ${rows}
        </table>
        <div style="font-size:10px;color:${MUTED_COLOR};margin-top:10px;font-style:italic;">${nlT(locale, 'affiliateDisclosure')}</div>
      </td></tr>
    </table>`;
}

// ─── Main layout builder ─────────────────────────────────────

// Legacy export for backward compatibility
const FEATURED_TOOLS = FEATURED_TOOLS_I18N.it;

/**
 * Build the complete newsletter HTML.
 *
 * @param {Object} data
 * @param {Object} [data.exchangeRate] - { rate: number, previousRate: number }
 * @param {Array}  [data.topArticles]  - [{ title, url, views, readingMinutes }]
 * @param {Object} [data.weeklyFact]   - { text: string, source?: string }
 * @param {Object} [data.latestArticle] - { title, excerpt, imageUrl, articleUrl }
 * @param {Object} [data.featuredTool]  - { title, description, buttonText, toolUrl } or null (auto-select)
 * @param {string} data.unsubscribeUrl  - Full URL with token
 * @param {string} [data.resubscribeUrl] - Full URL with token
 * @param {string} [data.preheaderText] - Preview text for email clients
 * @param {Object} [data.exchangeInsight] - exchange analytics + provider ranking
 * @param {Object} [data.sections]      - { exchange: true, outlook: true, articles: true, fact: true, latest: true, tool: true }
 * @param {string} [data.locale]        - 'it' | 'en' | 'de' | 'fr' (default: 'it')
 * @returns {string} complete HTML document
 */
export function buildNewsletter(data) {
  const locale = nlNormLocale(data.locale);
  const campaign = `weekly_${new Date().toISOString().split('T')[0]}`;
  const sections = data.sections || { exchange: true, outlook: true, articles: true, fact: true, latest: true, tool: true };

  // Select rotating tool based on week number (locale-aware)
  const localizedTools = FEATURED_TOOLS_I18N[locale] || FEATURED_TOOLS_I18N.it;
  const toolIndex = Math.floor((Date.now() - new Date('2025-01-06').getTime()) / (7 * 24 * 60 * 60 * 1000)) % localizedTools.length;
  const featuredTool = data.featuredTool || localizedTools[toolIndex];

  const preheader = data.preheaderText || (data.exchangeRate
    ? `${nlT(locale, 'preheaderRate')} • CHF/EUR ${data.exchangeRate.rate.toFixed(4)}`
    : nlT(locale, 'preheaderDefault'));

  let body = '';
  body += renderHero({ campaign, exchangeRate: data.exchangeRate, locale });
  if (sections.exchange && data.exchangeRate) body += renderExchangeRate({ ...data.exchangeRate, campaign, locale });
  if (sections.outlook && data.exchangeInsight) body += renderMarketOutlook({ insight: data.exchangeInsight, campaign, locale });
  if (sections.articles && data.topArticles?.length) body += renderTopArticles({ articles: data.topArticles, campaign, locale });
  if (sections.fact && data.weeklyFact) body += renderWeeklyFact({ ...data.weeklyFact, campaign, locale });
  if (sections.latest && data.latestArticle) body += renderLatestArticle({ ...data.latestArticle, campaign, locale });
  if (data.matchedJobs?.length) body += renderJobSection({ jobs: data.matchedJobs, campaign, locale });
  if (sections.tool && featuredTool) body += renderFeaturedTool({ ...featuredTool, campaign, locale });
  body += renderAffiliatePartners({ campaign, locale });

  return `<!DOCTYPE html>
<html lang="${locale}" xmlns:v="urn:schemas-microsoft-com:vml">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <title>${nlT(locale, 'weeklyTag')}</title>
  ${renderEmailActionMarkup({ campaign, locale })}
  <!--[if mso]><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml><![endif]-->
  <style>
    body { margin:0; padding:0; background:${LIGHT_BG}; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; }
    table { border-collapse:collapse; }
    img { border:0; max-width:100%; }
    a { color:${BRAND_BLUE}; }
    .preheader { display:none!important; font-size:1px; line-height:1px; max-height:0; max-width:0; opacity:0; overflow:hidden; }
    @media (prefers-color-scheme:dark) {
      body { background:${LIGHT_BG}!important; }
      .outer-card { background:${CARD_BG}!important; }
      .brand-text { color:${BRAND_DARK}!important; }
      .body-text { color:${TEXT_COLOR}!important; }
    }
    @media only screen and (max-width:620px) {
      .container { width:100%!important; padding:12px!important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;background:${LIGHT_BG};">
  <div class="preheader">${escapeHtml(preheader)}&nbsp;${'‌'.repeat(80)}</div>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:${LIGHT_BG};">
    <tr><td align="center" style="padding:24px 16px;">
      <table class="container" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
        <tr><td class="outer-card" style="background:${LIGHT_BG};padding:24px;">
          <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:16px;">
            <tr><td style="text-align:center;">
              <a href="${BASE_URL}" style="text-decoration:none;">
                <img src="${BASE_URL}/icons/icon-192x192.png" alt="Frontaliere Ticino" width="40" height="40" style="display:inline-block;vertical-align:middle;border-radius:10px;margin-right:8px;" />
                <span style="font-size:18px;font-weight:800;color:${BRAND_BLUE};vertical-align:middle;">Frontaliere Ticino</span>
              </a>
            </td></tr>
          </table>
          ${body}
        </td></tr>
        <!-- Footer -->
        <tr><td style="background:${CARD_BG};border:1px solid ${BORDER_COLOR};border-radius:16px;padding:18px;text-align:center;">
          <div style="font-size:13px;color:${MUTED_COLOR};line-height:1.6;">${nlT(locale, 'footerReason')}</div>
          <div style="margin-top:12px;font-size:12px;color:${MUTED_COLOR};line-height:1.8;">
            <a href="${data.unsubscribeUrl || '#'}" style="font-size:11px;color:${MUTED_COLOR};text-decoration:underline;">${nlT(locale, 'footerUnsub')}</a>
            <span style="color:${MUTED_COLOR};font-size:11px;"> · </span>
            <a href="${data.resubscribeUrl || '{{RESUBSCRIBE_URL}}'}" style="font-size:11px;color:${MUTED_COLOR};text-decoration:underline;">${nlT(locale, 'footerResub')}</a>
            <span style="color:${MUTED_COLOR};font-size:11px;"> · </span>
            <a href="${utmUrl('/privacy', campaign)}" style="font-size:11px;color:${MUTED_COLOR};text-decoration:underline;">${nlT(locale, 'footerPrivacy')}</a>
          </div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

export { FEATURED_TOOLS, FEATURED_TOOLS_I18N, utmUrl, escapeHtml, nlNormLocale };
