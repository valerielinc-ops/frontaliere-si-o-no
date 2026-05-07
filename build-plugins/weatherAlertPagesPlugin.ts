/**
 * weatherAlertPagesPlugin — emits 32 always-live alert SSG pages
 * (8 alert types × 4 locales) plus the /allerte-meteo/ hub × 4 = 4
 * additional pages. Total 36 URLs.
 *
 * Per /plan-design-review D11 (always-live, content-varies): pages stay
 * always indexable. When MeteoSwiss flags the alert active, render the
 * "ACTIVE" mode (danger banner + live state + impact). When dormant,
 * render the evergreen baseline (climatology + commute FAQ + historical
 * note) so text-html-ratio gate still passes off-event.
 *
 * SKIP_WEATHER=1 disables this plugin (matches the city plugin contract).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';
import { WEATHER_ALERT_CONFIG, type WeatherAlertConfig } from '../data/weatherAlertConfig';
import { evaluateAlerts, activeAlerts, dormantAlerts } from '../services/weatherAlertEvaluator';
import { parseWeatherSnapshot, type AlertState, type WeatherSnapshot } from '../services/weather/types';
import type { Locale } from '../services/weather/wmoCodes';

const LOCALES: readonly Locale[] = Object.freeze(['it', 'en', 'de', 'fr']);
const TITLE_MAX = 66;

const HUB_SLUG: Record<Locale, string> = {
  it: 'allerte-meteo',
  en: 'weather-alerts',
  de: 'wetterwarnungen',
  fr: 'alertes-meteo',
};

const HUB_TITLE: Record<Locale, string> = {
  it: 'Allerte meteo per il commute frontaliere',
  en: 'Weather alerts for cross-border commute',
  de: 'Wetterwarnungen für Pendler',
  fr: 'Alertes météo pour les frontaliers',
};

const HUB_TAGLINE: Record<Locale, string> = {
  it: 'Eventi meteo monitorati 24/7 dalle fonti ufficiali svizzere e italiane',
  en: 'Weather events monitored 24/7 from official Swiss and Italian sources',
  de: '24/7 überwachte Wetterereignisse aus offiziellen Schweizer und italienischen Quellen',
  fr: 'Événements météo surveillés 24/7 par les sources officielles suisses et italiennes',
};

const ALERTS_PARENT_SLUG = 'allerte';
const ALERTS_PARENT_BY_LOCALE: Record<Locale, string> = {
  it: 'allerte',
  en: 'alerts',
  de: 'warnungen',
  fr: 'alertes',
};

export function weatherAlertPagesPlugin(rootDir: string): Plugin {
  return {
    name: 'frontaliere:weather-alert-pages',
    apply: 'build',
    enforce: 'post',
    closeBundle() {
      if (process.env.SKIP_WEATHER === '1') {
        console.log('[weather-alert-pages] SKIP_WEATHER=1 → skipped');
        return;
      }
      const distDir = resolve(rootDir, 'dist');
      if (!existsSync(distDir)) {
        console.warn('[weather-alert-pages] dist/ missing, skipping');
        return;
      }
      const snapshot = loadSnapshot(rootDir);
      let count = 0;

      // Hub pages — 1 per locale
      for (const locale of LOCALES) {
        const hubPath = locale === 'it' ? `${HUB_SLUG.it}/index.html` : `${locale}/${HUB_SLUG[locale]}/index.html`;
        const hubFull = resolve(distDir, hubPath);
        ensureDir(hubFull);
        writeFileSync(hubFull, renderHub(locale, snapshot), 'utf-8');
        count += 1;
      }

      // Alert pages — 8 alerts × 4 locales = 32
      for (const locale of LOCALES) {
        for (const cfg of WEATHER_ALERT_CONFIG) {
          const slug = cfg.slug[locale];
          const pagePath = locale === 'it' ? `${ALERTS_PARENT_SLUG}/${slug}/index.html` : `${locale}/${ALERTS_PARENT_BY_LOCALE[locale]}/${slug}/index.html`;
          const fileFull = resolve(distDir, pagePath);
          ensureDir(fileFull);
          const state = snapshot?.alerts[cfg.id];
          writeFileSync(fileFull, renderAlertPage(locale, cfg, state, snapshot?.generatedAt), 'utf-8');
          count += 1;
        }
      }

      writeSitemap(rootDir, snapshot?.generatedAt);
      console.log(`[weather-alert-pages] emitted ${count} pages`);
    },
  };
}

function loadSnapshot(rootDir: string): WeatherSnapshot | null {
  const path = resolve(rootDir, 'data/weather-snapshot.json');
  if (!existsSync(path)) return null;
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    const parsed = parseWeatherSnapshot(raw);
    if (!parsed.ok) {
      const err = parsed as { ok: false; error: string; path?: string };
      console.warn(`[weather-alert-pages] snapshot parse failed: ${err.error} at ${err.path ?? '?'}`);
      return null;
    }
    return parsed.value;
  } catch (e) {
    console.warn(`[weather-alert-pages] snapshot read failed: ${(e as Error).message}`);
    return null;
  }
}

function ensureDir(filePath: string): void {
  mkdirSync(resolve(filePath, '..'), { recursive: true });
}

function buildTitle(headline: string): string {
  const withBrand = `${headline} | Frontaliere Ticino`;
  return withBrand.length <= TITLE_MAX ? withBrand : headline;
}

function renderHub(locale: Locale, snap: WeatherSnapshot | null): string {
  const title = buildTitle(HUB_TITLE[locale]);
  const description = HUB_TAGLINE[locale];
  const localePath = locale === 'it' ? '' : `/${locale}`;
  const canonical = `https://frontaliereticino.ch${localePath}/${HUB_SLUG[locale]}/`;
  const active = activeAlerts(snap);
  const dormant = dormantAlerts(snap);
  const counter = locale === 'it'
    ? `${active.length} attive · ${dormant.length} monitorate`
    : locale === 'en'
    ? `${active.length} active · ${dormant.length} monitored`
    : locale === 'de'
    ? `${active.length} aktiv · ${dormant.length} überwacht`
    : `${active.length} actives · ${dormant.length} surveillées`;

  const activeRows = active.map((a) => renderHubRow(locale, a.config, a.state)).join('\n');
  const dormantRows = dormant.map((a) => renderHubRow(locale, a.config, a.state)).join('\n');
  const intro = renderHubIntro(locale);

  return wrapHtml({
    locale, title, description, canonical,
    bodyHtml: `
<header><h1>${escapeHtml(HUB_TITLE[locale])}</h1>
<p class="tagline">${escapeHtml(HUB_TAGLINE[locale])}</p>
<p class="alert-counter">${escapeHtml(counter)}</p></header>
${active.length > 0 ? `<section class="alerts-active"><h2>${activeHeader(locale)}</h2>${activeRows}</section>` : ''}
<section class="alerts-dormant"><h2>${dormantHeader(locale)}</h2>${dormantRows}</section>
<section class="hub-intro">${intro}</section>
<section class="attribution"><p>${attributionInline(locale, snap?.generatedAt)}</p></section>
`,
    generatedAt: snap?.generatedAt,
  });
}

function renderHubIntro(locale: Locale): string {
  const para1 = locale === 'it'
    ? `Le allerte meteo per il commute frontaliere arrivano dalle fonti ufficiali svizzere (MeteoSwiss bollettini cantonali) e italiane (regioni Lombardia). L\'aggiornamento è continuo: questa pagina riflette lo stato a 4 ore dall\'ultimo cron pipeline. Quando un\'allerta è attiva, la pagina dedicata espone il dato live, l\'impatto sui valichi e il consiglio commute. Quando dormiente, la pagina rimane indicizzata con il contenuto evergreen (climatologia, FAQ, link contestuali).`
    : locale === 'en'
    ? `Weather alerts for cross-border commute come from official Swiss (MeteoSwiss cantonal bulletins) and Italian (Lombardy region) sources. Updates are continuous; this page reflects the state at most 4 hours behind the latest cron pipeline. When an alert is active, the dedicated page exposes live data, valico impact, and commute advice. When dormant, the page stays indexed with evergreen content (climatology, FAQ, contextual links).`
    : locale === 'de'
    ? `Wetterwarnungen für Pendler kommen aus offiziellen Schweizer (MeteoSwiss-Bulletins) und italienischen Quellen (Region Lombardei). Updates sind laufend; diese Seite spiegelt den Stand maximal 4 Stunden hinter der letzten Cron-Pipeline wider. Wenn eine Warnung aktiv ist, zeigt die dedizierte Seite Live-Daten, Übergangs-Auswirkungen und Pendler-Hinweise. Wenn ruhig, bleibt die Seite indexiert mit Evergreen-Inhalt (Klimatologie, FAQ, kontextuelle Links).`
    : `Les alertes météo pour le commute frontalier proviennent des sources officielles suisses (bulletins MeteoSwiss cantonaux) et italiennes (région Lombardie). Les mises à jour sont continues; cette page reflète l\'état au maximum 4 heures derrière le dernier pipeline cron. Lorsqu\'une alerte est active, la page dédiée expose les données en direct, l\'impact aux passages et les conseils commute. Lorsqu\'elle est dormante, la page reste indexée avec un contenu evergreen (climatologie, FAQ, liens contextuels).`;
  return `<p>${escapeHtml(para1)}</p>`;
}

function activeHeader(l: Locale): string { return l === 'it' ? 'Allerte attive' : l === 'en' ? 'Active alerts' : l === 'de' ? 'Aktive Warnungen' : 'Alertes actives'; }
function dormantHeader(l: Locale): string { return l === 'it' ? 'Eventi monitorati' : l === 'en' ? 'Monitored events' : l === 'de' ? 'Überwachte Ereignisse' : 'Événements surveillés'; }

function renderHubRow(locale: Locale, cfg: WeatherAlertConfig, state: AlertState): string {
  const slug = cfg.slug[locale];
  const localePath = locale === 'it' ? '' : `/${locale}`;
  const url = `${localePath}/${ALERTS_PARENT_BY_LOCALE[locale]}/${slug}/`;
  const badge = state.active
    ? `<span class="alert-badge danger">${activeLabel(locale)}</span>`
    : `<span class="alert-badge dormant">${dormantLabel(locale)}</span>`;
  return `<a class="alert-row" href="${url}">${badge}<span class="alert-name">${escapeHtml(cfg.title[locale])}</span><span class="alert-tagline">${escapeHtml(cfg.tagline[locale])}</span></a>`;
}

function activeLabel(l: Locale): string { return l === 'it' ? 'Attiva' : l === 'en' ? 'Active' : l === 'de' ? 'Aktiv' : 'Active'; }
function dormantLabel(l: Locale): string { return l === 'it' ? 'Monitorata' : l === 'en' ? 'Monitored' : l === 'de' ? 'Überwacht' : 'Surveillée'; }

function renderAlertPage(locale: Locale, cfg: WeatherAlertConfig, state: AlertState | undefined, generatedAt: string | undefined): string {
  const headline = cfg.title[locale];
  const title = buildTitle(headline);
  const tagline = cfg.tagline[locale];
  const description = `${tagline} · MeteoSwiss + Frontaliere Ticino`;
  const slug = cfg.slug[locale];
  const localePath = locale === 'it' ? '' : `/${locale}`;
  const canonical = `https://frontaliereticino.ch${localePath}/${ALERTS_PARENT_BY_LOCALE[locale]}/${slug}/`;
  const active = state?.active === true;
  const breadcrumb = renderBreadcrumb(locale, cfg);
  const stateHtml = active ? renderActiveState(locale, cfg, state!) : renderDormantState(locale, cfg);
  const evergreenHtml = renderEvergreen(locale, cfg);
  const ctaHtml = renderCta(locale, `weather-alert-${cfg.id}`);
  const faqHtml = renderFaq(locale, cfg);

  return wrapHtml({
    locale, title, description, canonical,
    bodyHtml: `
${breadcrumb}
<header><h1>${escapeHtml(headline)}</h1>
<p class="tagline">${escapeHtml(tagline)}</p></header>
${stateHtml}
${ctaHtml}
${evergreenHtml}
${faqHtml}
<section class="attribution"><p>${attributionInline(locale, generatedAt)}</p></section>
`,
    generatedAt,
  });
}

function renderBreadcrumb(locale: Locale, cfg: WeatherAlertConfig): string {
  const localePath = locale === 'it' ? '' : `/${locale}`;
  const homeText = locale === 'it' ? 'Home' : locale === 'en' ? 'Home' : locale === 'de' ? 'Start' : 'Accueil';
  return `<nav aria-label="Breadcrumb"><ol class="breadcrumb"><li><a href="${localePath}/">${homeText}</a></li><li><a href="${localePath}/${HUB_SLUG[locale]}/">${escapeHtml(HUB_TITLE[locale])}</a></li><li aria-current="page">${escapeHtml(cfg.title[locale])}</li></ol></nav>`;
}

function renderActiveState(locale: Locale, cfg: WeatherAlertConfig, state: AlertState): string {
  const heading = locale === 'it' ? 'Allerta attiva ora' : locale === 'en' ? 'Alert active now' : locale === 'de' ? 'Warnung jetzt aktiv' : 'Alerte active maintenant';
  const sourceLabel = state.source ? `${locale === 'it' ? 'Fonte' : 'Source'}: ${escapeHtml(state.source)}` : '';
  const startedLabel = state.startedAt ? `<time datetime="${escapeHtml(state.startedAt)}">${formatStarted(locale, state.startedAt)}</time>` : '';
  const metricLabel = state.metric ? `${state.metric.value}${state.metric.unit}` : '';
  const description = state.description ? `<p class="alert-description">${escapeHtml(state.description)}</p>` : '';
  return `<section class="alert-state active" aria-live="assertive" data-state="active">
<div class="alert-banner danger" role="alert"><strong>${escapeHtml(heading)}</strong>${metricLabel ? ` · ${escapeHtml(metricLabel)}` : ''}${startedLabel ? ` · ${startedLabel}` : ''}</div>
${description}
${sourceLabel ? `<p class="alert-source">${sourceLabel}</p>` : ''}
</section>`;
}

function renderDormantState(locale: Locale, _cfg: WeatherAlertConfig): string {
  const heading = locale === 'it' ? 'Nessuna allerta attiva' : locale === 'en' ? 'No active alert' : locale === 'de' ? 'Keine aktive Warnung' : 'Aucune alerte active';
  const sub = locale === 'it'
    ? 'Pagina sempre attiva: monitoriamo l\'evento 24/7. Quando MeteoSwiss emette un\'allerta, questa pagina mostra il dato live entro 4 ore dal cron pipeline.'
    : locale === 'en'
    ? 'Always-on page: we monitor the event 24/7. When MeteoSwiss issues an alert, this page shows live data within 4 hours of the cron pipeline.'
    : locale === 'de'
    ? 'Always-on-Seite: Wir überwachen das Ereignis 24/7. Wenn MeteoSwiss eine Warnung herausgibt, zeigt diese Seite Live-Daten innerhalb von 4 Stunden nach der Cron-Pipeline.'
    : 'Page toujours active: nous surveillons l\'événement 24/7. Lorsque MeteoSwiss émet une alerte, cette page affiche les données en direct dans les 4 heures suivant le pipeline cron.';
  return `<section class="alert-state dormant" aria-live="polite" data-state="dormant">
<div class="alert-banner success-subtle"><strong>${escapeHtml(heading)}</strong></div>
<p>${escapeHtml(sub)}</p>
</section>`;
}

function formatStarted(locale: Locale, iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const date = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
    const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const sinceLabel = locale === 'it' ? 'Da' : locale === 'en' ? 'Since' : locale === 'de' ? 'Seit' : 'Depuis';
    return `${sinceLabel} ${date} ${time}`;
  } catch {
    return iso;
  }
}

function renderEvergreen(locale: Locale, cfg: WeatherAlertConfig): string {
  const heading = locale === 'it' ? `Cosa fare in caso di ${cfg.title[locale].toLowerCase()}` : locale === 'en' ? `What to do during ${cfg.title[locale]}` : locale === 'de' ? `Was tun bei ${cfg.title[locale]}` : `Que faire en cas de ${cfg.title[locale]}`;
  const para1 = evergreenContent(locale, cfg.id);
  const climatologyHeading = locale === 'it' ? 'Climatologia tipica' : locale === 'en' ? 'Typical climatology' : locale === 'de' ? 'Typische Klimatologie' : 'Climatologie typique';
  const climatology = climatologyContent(locale, cfg.id);
  return `<section class="evergreen"><h2>${escapeHtml(heading)}</h2><p>${escapeHtml(para1)}</p>
<h3>${escapeHtml(climatologyHeading)}</h3><p>${escapeHtml(climatology)}</p></section>`;
}

function evergreenContent(locale: Locale, alertId: string): string {
  const it: Record<string, string> = {
    'snow-gottardo': 'In caso di neve sul San Gottardo, la galleria autostradale A2 (la galleria di base) resta solitamente aperta perché protetta dalle intemperie. La strada del passo (alta quota) viene chiusa quando la neve supera 5-10 cm. Per i frontalieri Como-Lugano via Chiasso o Stabio, l\'A2 resta la rotta più affidabile; chi viene da Lecco o Bergamo deve verificare la galleria San Bernardino come alternativa. Pneumatici invernali obbligatori in Svizzera dal 1 novembre al 30 aprile (fines fino a CHF 100 per non conformità).',
    'nebbia-mendrisio': 'La nebbia fitta nel Mendrisiotto colpisce tipicamente i valichi Chiasso, Stabio e Gaggiolo nelle prime ore del mattino (5-9 AM), con visibilità che scende sotto i 100 metri. I controlli doganali rallentano significativamente. Frontalieri abituali raccomandano di partire 20-30 minuti prima del solito, mantenere distanze di sicurezza maggiori, accendere fendinebbia ma non abbaglianti. Le uscite Como Sud e Lago di Como sull\'A9 sono spesso preferibili in queste condizioni.',
    'gelo-confine': 'Il gelo notturno (-2°C o inferiore) sulle strade del confine richiede pneumatici invernali e particolare attenzione su ponti, sottopassi e strade in ombra (es. Strada Cantonale 17 sopra Mendrisio, ramo nord di Capolago). I valichi Stabio e Gaggiolo, su strade secondarie con poca circolazione notturna, sono particolarmente vulnerabili. Si raccomanda di rallentare a 30-40 km/h nelle prime ore del mattino e durante il rientro serale invernale.',
    'vento-forte-mendrisio': 'Le raffiche di vento forte (> 70 km/h) nel Mendrisiotto creano problemi specifici per mezzi alti e moto. Frontalieri con auto compatte sono meno esposti, ma la cintura A2 tra Mendrisio e Chiasso ha sezioni in galleria a vento aperto dove le raffiche possono spostare il veicolo. Consigliamo cautela e velocità ridotta a 80 km/h durante allerta.',
    'grandine-lecco': 'I temporali con grandine nelle valli lecchesi (Valsassina, Valassina) possono causare danni a parabrezza e cantieri all\'aperto. Per i frontalieri lecchesi che lavorano nell\'edilizia ticinese, le mattine post-temporale richiedono verifica delle attrezzature lasciate in cantiere. La SS36 da Lecco verso Como subisce occasionali chiusure per pulizia detriti.',
    'ondata-caldo-ticino': 'Le ondate di caldo (>32°C protratto) influenzano direttamente il commute auto: aria condizionata sotto stress, traffico più denso a Brogeda nelle ore di punta, attese più lunghe per chi guida senza AC. Frontalieri che lavorano all\'aperto (edilizia, agricoltura, trasporti) devono adattare gli orari come da CCNL svizzero settoriale. L\'A2 ha aree di sosta climatizzate a Mendrisio Sud e Bissone.',
    'alluvione-rischio': 'Il rischio alluvione in Ticino interessa principalmente i bacini del Lago Maggiore e Lago di Lugano, con possibili chiusure di strade lungolago. La Cantonale 13 (Locarno-Brissago) e la 23 (Lugano-Melide) sono le più vulnerabili. Per i frontalieri Como-Locarno via lago, traghetti possono essere sospesi temporaneamente. Verificare sempre le condizioni di Capolago, Magadino, e Brissago prima di partire.',
    'ghiaccio-strade': 'Le strade ghiacciate al confine richiedono freni in modalità anti-bloccaggio (ABS), mantenere distanze di 4 secondi anziché 2, evitare manovre brusche. I tratti più critici sono la galleria Vedeggio-Cassarate (rampa di uscita), il ponte sul Tresa al valico di Ponte Tresa, e la Strada Cantonale 2 sopra Capolago. In Italia, la SP35 (Como-Cantù) è notoriamente scivolosa nei tratti boschivi.',
  };
  const en: Record<string, string> = {
    'snow-gottardo': 'During snow at Gotthard, the A2 motorway tunnel (the base tunnel) usually stays open because it is sheltered from weather. The pass road (high altitude) closes when snow exceeds 5-10 cm. For Como-Lugano commuters via Chiasso or Stabio, the A2 remains the most reliable route; those coming from Lecco or Bergamo should check the San Bernardino tunnel as an alternative. Winter tyres mandatory in Switzerland from 1 November to 30 April (fines up to CHF 100 for non-compliance).',
    'nebbia-mendrisio': 'Dense fog in the Mendrisio area typically hits Chiasso, Stabio, and Gaggiolo crossings in early morning hours (5-9 AM) with visibility dropping below 100 metres. Customs checks slow significantly. Regular commuters recommend leaving 20-30 minutes earlier, keeping greater safety distances, using fog lights but not high beams. The Como Sud and Lago di Como exits on the A9 are often preferable in these conditions.',
    'gelo-confine': 'Overnight frost (-2°C or below) on border roads requires winter tyres and particular attention on bridges, underpasses, and shaded sections. Stabio and Gaggiolo crossings on quiet secondary roads are particularly vulnerable. Slow to 30-40 km/h in early morning hours and during winter evening commute.',
    'vento-forte-mendrisio': 'Strong wind gusts (>70 km/h) in Mendrisio area create specific issues for high-sided vehicles and motorcycles. Frontaliers with compact cars are less exposed, but the A2 belt between Mendrisio and Chiasso has open-wind tunnel sections where gusts can shift the vehicle. Caution recommended at reduced 80 km/h during alert.',
    'grandine-lecco': 'Hail thunderstorms in Lecco valleys (Valsassina, Valassina) can damage windshields and outdoor worksites. Lecco frontaliers in Ticino construction must check equipment left on-site after morning storms. The SS36 from Lecco toward Como occasionally closes for debris cleanup.',
    'ondata-caldo-ticino': 'Heatwaves (>32°C sustained) directly affect car commute: air conditioning under stress, denser traffic at Brogeda peak hours, longer waits for those driving without AC. Outdoor frontaliers (construction, agriculture, transport) must adapt schedules per Swiss sectoral CCNL. The A2 has climatised rest areas at Mendrisio Sud and Bissone.',
    'alluvione-rischio': 'Flood risk in Ticino mainly involves Lake Maggiore and Lake Lugano basins, with possible lakeshore road closures. Cantonal road 13 (Locarno-Brissago) and 23 (Lugano-Melide) are most vulnerable. For Como-Locarno commuters via lake, ferries may be temporarily suspended. Always verify conditions at Capolago, Magadino, and Brissago before leaving.',
    'ghiaccio-strade': 'Icy border roads require anti-lock braking (ABS) mode, 4-second following distance instead of 2, avoidance of sudden maneuvers. Most critical sections: Vedeggio-Cassarate tunnel exit ramp, Tresa bridge at Ponte Tresa crossing, Cantonal road 2 above Capolago. In Italy, SP35 (Como-Cantù) is notoriously slippery in wooded sections.',
  };
  const de: Record<string, string> = {
    'snow-gottardo': 'Bei Schnee am Gotthard bleibt der A2-Autobahntunnel (Basistunnel) meist offen, da wettergeschützt. Die Passstrasse (Höhenlage) wird geschlossen, wenn der Schnee 5-10 cm überschreitet. Für Pendler Como-Lugano via Chiasso oder Stabio bleibt die A2 die zuverlässigste Route; wer aus Lecco oder Bergamo kommt, sollte den San Bernardino als Alternative prüfen. Winterreifenpflicht in der Schweiz vom 1. November bis 30. April (Bussen bis CHF 100).',
    'nebbia-mendrisio': 'Dichter Nebel im Mendrisiotto trifft typischerweise die Übergänge Chiasso, Stabio und Gaggiolo in den frühen Morgenstunden (5-9 Uhr), wobei die Sicht unter 100 Meter fällt. Zollkontrollen verlangsamen sich erheblich. Empfehlung: 20-30 Minuten früher abfahren, grössere Sicherheitsabstände, Nebelscheinwerfer ohne Fernlicht.',
    'gelo-confine': 'Nachtfrost (-2°C oder darunter) auf Grenzstrassen erfordert Winterreifen und besondere Vorsicht auf Brücken, Unterführungen und schattigen Strecken. Übergänge Stabio und Gaggiolo auf wenig befahrenen Nebenstrassen sind besonders gefährdet. Auf 30-40 km/h verlangsamen in frühen Morgen- und winterlichen Abendstunden.',
    'vento-forte-mendrisio': 'Starke Windböen (>70 km/h) im Mendrisiotto schaffen spezifische Probleme für hohe Fahrzeuge und Motorräder. Frontalier mit Kompaktwagen sind weniger gefährdet, aber der A2-Gürtel zwischen Mendrisio und Chiasso hat offene Tunnelabschnitte, wo Böen das Fahrzeug verschieben können. Vorsicht und reduzierte Geschwindigkeit 80 km/h bei Warnung empfohlen.',
    'grandine-lecco': 'Hagelgewitter in den Lecchese-Tälern (Valsassina, Valassina) können Windschutzscheiben und Aussenbaustellen beschädigen. Lecchese-Frontalier im Tessiner Bauwesen müssen nach Morgengewittern die auf der Baustelle gelassene Ausrüstung überprüfen. Die SS36 von Lecco Richtung Como wird gelegentlich zur Trümmerräumung geschlossen.',
    'ondata-caldo-ticino': 'Hitzewellen (>32°C anhaltend) wirken direkt auf den Auto-Pendelverkehr: Klimaanlage unter Stress, dichterer Verkehr in Brogeda-Spitzenstunden, längere Wartezeiten ohne AC. Frontalier im Aussenbereich (Bau, Landwirtschaft, Transport) müssen Zeitpläne gemäss Schweizer Branchen-CCNL anpassen. Die A2 hat klimatisierte Rastplätze in Mendrisio Sud und Bissone.',
    'alluvione-rischio': 'Hochwasserrisiko im Tessin betrifft hauptsächlich die Becken des Lago Maggiore und Lago di Lugano mit möglichen Strassensperrungen am Seeufer. Kantonsstrasse 13 (Locarno-Brissago) und 23 (Lugano-Melide) sind am stärksten gefährdet. Für Pendler Como-Locarno per See können Fähren vorübergehend ausgesetzt werden. Vor der Abfahrt immer die Bedingungen in Capolago, Magadino und Brissago überprüfen.',
    'ghiaccio-strade': 'Vereiste Grenzstrassen erfordern Anti-Blockier-Bremsmodus (ABS), 4-Sekunden-Folgeabstand statt 2, Vermeidung plötzlicher Manöver. Kritischste Abschnitte: Tunnel Vedeggio-Cassarate (Ausfahrtsrampe), Tresa-Brücke am Übergang Ponte Tresa, Kantonsstrasse 2 oberhalb Capolago. In Italien ist die SP35 (Como-Cantù) in Waldabschnitten bekanntlich rutschig.',
  };
  const fr: Record<string, string> = {
    'snow-gottardo': 'En cas de neige au Gothard, le tunnel autoroutier A2 (le tunnel de base) reste habituellement ouvert car abrité des intempéries. La route du col (altitude) ferme lorsque la neige dépasse 5-10 cm. Pour les frontaliers Como-Lugano via Chiasso ou Stabio, l\'A2 reste la route la plus fiable; ceux venant de Lecco ou Bergamo doivent vérifier le tunnel San Bernardino comme alternative. Pneus hiver obligatoires en Suisse du 1er novembre au 30 avril (amendes jusqu\'à CHF 100).',
    'nebbia-mendrisio': 'Le brouillard dense dans le Mendrisiotto frappe typiquement les passages Chiasso, Stabio et Gaggiolo en début de matinée (5-9h) avec une visibilité tombant sous 100 mètres. Les contrôles douaniers ralentissent considérablement. Recommandation: partir 20-30 minutes plus tôt, distances de sécurité plus grandes, antibrouillards sans pleins phares.',
    'gelo-confine': 'Le gel nocturne (-2°C ou inférieur) sur les routes frontalières exige des pneus hiver et une attention particulière sur les ponts, passages souterrains et tronçons ombragés. Les passages Stabio et Gaggiolo sur routes secondaires peu fréquentées sont particulièrement vulnérables. Ralentir à 30-40 km/h tôt le matin et lors des trajets hivernaux en soirée.',
    'vento-forte-mendrisio': 'Les rafales de vent fort (>70 km/h) dans le Mendrisiotto créent des problèmes spécifiques pour les véhicules hauts et les motos. Les frontaliers en voitures compactes sont moins exposés, mais la ceinture A2 entre Mendrisio et Chiasso a des sections de tunnel ouvert au vent où les rafales peuvent déplacer le véhicule. Prudence à 80 km/h lors d\'une alerte.',
    'grandine-lecco': 'Les orages de grêle dans les vallées lecchesi (Valsassina, Valassina) peuvent endommager pare-brise et chantiers extérieurs. Les frontaliers lecchesi dans le bâtiment tessinois doivent vérifier l\'équipement laissé sur chantier après les orages matinaux. La SS36 de Lecco vers Côme ferme occasionnellement pour nettoyage des débris.',
    'ondata-caldo-ticino': 'Les canicules (>32°C soutenu) affectent directement les trajets en voiture: climatisation sous stress, trafic plus dense à Brogeda aux heures de pointe, attentes plus longues sans AC. Les frontaliers en extérieur (BTP, agriculture, transport) doivent adapter les horaires selon le CCT sectoriel suisse. L\'A2 a des aires de repos climatisées à Mendrisio Sud et Bissone.',
    'alluvione-rischio': 'Le risque d\'inondation au Tessin concerne principalement les bassins du lac Majeur et du lac de Lugano, avec possibles fermetures de routes en bord de lac. Les routes cantonales 13 (Locarno-Brissago) et 23 (Lugano-Melide) sont les plus vulnérables. Pour les frontaliers Côme-Locarno par lac, les ferries peuvent être temporairement suspendus. Toujours vérifier les conditions à Capolago, Magadino et Brissago avant de partir.',
    'ghiaccio-strade': 'Les routes verglacées à la frontière exigent le mode freinage anti-blocage (ABS), 4 secondes de distance au lieu de 2, éviter les manœuvres brusques. Tronçons les plus critiques: rampe de sortie du tunnel Vedeggio-Cassarate, pont sur la Tresa au passage Ponte Tresa, route cantonale 2 au-dessus de Capolago. En Italie, la SP35 (Côme-Cantù) est notoirement glissante dans les sections boisées.',
  };
  const map = locale === 'it' ? it : locale === 'en' ? en : locale === 'de' ? de : fr;
  return map[alertId] ?? '';
}

function climatologyContent(locale: Locale, alertId: string): string {
  const it: Record<string, string> = {
    'snow-gottardo': 'Il San Gottardo riceve neve da novembre ad aprile, con accumuli più frequenti tra dicembre e marzo. Eventi di chiusura del passo durano in media 1-3 giorni; chiusure del tunnel di base sono rare e legate a eventi straordinari (ghiaccio stalattitico, manutenzione).',
    'nebbia-mendrisio': 'La nebbia nel Mendrisiotto è un fenomeno tipicamente invernale (ottobre-marzo) legato all\'inversione termica del Lago di Lugano. Mattine consecutive con nebbia possono persistere 5-10 giorni; il sole solitamente scioglie la nebbia entro le 10-11 del mattino.',
    'gelo-confine': 'Il gelo notturno è frequente da dicembre a febbraio nelle aree di confine, con minime occasionali di -8/-10°C. Le strade in ombra (galleria di carenatura della Cantonale 2) possono mantenere ghiaccio anche in pieno giorno se la temperatura non sale sopra zero.',
    'vento-forte-mendrisio': 'Il vento forte nel Mendrisiotto è raro ma significativo quando si verifica: episodi di föhn discendente con raffiche oltre 80 km/h sono documentati 3-5 volte all\'anno, prevalentemente in primavera e autunno.',
    'grandine-lecco': 'Le valli lecchesi sono soggette a temporali violenti tra maggio e settembre, con grandine localizzata in 8-15 episodi annui. La Valsassina è particolarmente esposta per via dell\'orografia che concentra le celle temporalesche.',
    'ondata-caldo-ticino': 'Le ondate di caldo prolungate (>30°C per 5+ giorni consecutivi) sono diventate più frequenti dopo il 2003. Eventi recenti: 2017, 2019, 2022, 2023, 2024 — con punte storiche oltre 38°C registrate a Lugano nel luglio 2023.',
    'alluvione-rischio': 'Le alluvioni in Ticino sono storicamente legate a sistemi di precipitazioni intense da SUD/SUD-EST (correnti scirocco) tra ottobre e novembre. Eventi maggiori: 2000, 2014, 2018, 2024.',
    'ghiaccio-strade': 'Il ghiaccio nelle strade del confine è tipico dei mesi novembre-marzo, con picchi quando la temperatura passa rapidamente sotto zero dopo precipitazioni. Le strade più esposte sono quelle in zone d\'ombra mattutina e i ponti.',
  };
  const en: Record<string, string> = {
    'snow-gottardo': 'Gotthard receives snow from November to April, with most accumulation between December and March. Pass closure events last on average 1-3 days; base tunnel closures are rare and linked to extraordinary events (ice stalactites, maintenance).',
    'nebbia-mendrisio': 'Fog in Mendrisio is typically a winter phenomenon (October-March) tied to Lake Lugano thermal inversion. Consecutive foggy mornings can persist 5-10 days; sun usually clears the fog by 10-11 AM.',
    'gelo-confine': 'Overnight frost is frequent from December to February in border areas with occasional -8/-10°C minimums. Shaded roads can retain ice even during full daylight if temperature does not rise above zero.',
    'vento-forte-mendrisio': 'Strong wind in Mendrisio is rare but significant when occurring: föhn events with gusts over 80 km/h are documented 3-5 times per year, mostly in spring and autumn.',
    'grandine-lecco': 'Lecco valleys are subject to violent thunderstorms between May and September, with localised hail in 8-15 annual events. Valsassina is particularly exposed due to orography that concentrates storm cells.',
    'ondata-caldo-ticino': 'Prolonged heatwaves (>30°C for 5+ consecutive days) have become more frequent after 2003. Recent events: 2017, 2019, 2022, 2023, 2024 — with historic peaks over 38°C recorded in Lugano in July 2023.',
    'alluvione-rischio': 'Floods in Ticino are historically linked to intense precipitation systems from SOUTH/SOUTH-EAST (sirocco currents) between October and November. Major events: 2000, 2014, 2018, 2024.',
    'ghiaccio-strade': 'Ice on border roads is typical of November-March months, with peaks when temperature drops rapidly below zero after precipitation. Most exposed roads are in morning shade zones and bridges.',
  };
  const de: Record<string, string> = {
    'snow-gottardo': 'Der Gotthard bekommt Schnee von November bis April, mit der meisten Akkumulation zwischen Dezember und März. Pass-Sperrereignisse dauern durchschnittlich 1-3 Tage; Basistunnel-Sperrungen sind selten und mit aussergewöhnlichen Ereignissen verbunden.',
    'nebbia-mendrisio': 'Nebel im Mendrisiotto ist typisch ein Winterphänomen (Oktober-März), verbunden mit der thermischen Inversion des Lago di Lugano. Aufeinanderfolgende neblige Morgen können 5-10 Tage anhalten; die Sonne löst den Nebel meist bis 10-11 Uhr auf.',
    'gelo-confine': 'Nachtfrost ist häufig von Dezember bis Februar in Grenzgebieten mit gelegentlichen Minima von -8/-10°C. Schattige Strassen können auch tagsüber Eis behalten, wenn die Temperatur nicht über null steigt.',
    'vento-forte-mendrisio': 'Starker Wind im Mendrisiotto ist selten, aber signifikant: Föhn-Ereignisse mit Böen über 80 km/h sind 3-5 Mal pro Jahr dokumentiert, hauptsächlich im Frühling und Herbst.',
    'grandine-lecco': 'Die Lecchese-Täler sind heftigen Gewittern zwischen Mai und September ausgesetzt, mit lokalisiertem Hagel in 8-15 Jahresereignissen. Valsassina ist besonders exponiert.',
    'ondata-caldo-ticino': 'Anhaltende Hitzewellen (>30°C für 5+ aufeinanderfolgende Tage) sind nach 2003 häufiger geworden. Jüngste Ereignisse: 2017, 2019, 2022, 2023, 2024 — mit historischen Spitzen über 38°C in Lugano im Juli 2023.',
    'alluvione-rischio': 'Überschwemmungen im Tessin sind historisch mit intensiven Niederschlagssystemen aus Süden/Süd-Osten (Schiroccoströmungen) zwischen Oktober und November verbunden. Grosse Ereignisse: 2000, 2014, 2018, 2024.',
    'ghiaccio-strade': 'Eis auf Grenzstrassen ist typisch für die Monate November-März, mit Spitzen, wenn die Temperatur nach Niederschlägen schnell unter null fällt.',
  };
  const fr: Record<string, string> = {
    'snow-gottardo': 'Le Gothard reçoit de la neige de novembre à avril, avec le plus d\'accumulation entre décembre et mars. Les événements de fermeture du col durent en moyenne 1-3 jours; les fermetures du tunnel de base sont rares.',
    'nebbia-mendrisio': 'Le brouillard dans le Mendrisiotto est un phénomène typiquement hivernal (octobre-mars) lié à l\'inversion thermique du lac de Lugano. Les matinées consécutives de brouillard peuvent persister 5-10 jours.',
    'gelo-confine': 'Le gel nocturne est fréquent de décembre à février dans les zones frontalières avec des minimums occasionnels de -8/-10°C. Les routes ombragées peuvent conserver de la glace même en plein jour.',
    'vento-forte-mendrisio': 'Le vent fort dans le Mendrisiotto est rare mais significatif: des événements de föhn avec rafales de plus de 80 km/h sont documentés 3-5 fois par an, principalement au printemps et en automne.',
    'grandine-lecco': 'Les vallées lecchesi sont soumises à des orages violents entre mai et septembre, avec grêle localisée dans 8-15 événements annuels.',
    'ondata-caldo-ticino': 'Les canicules prolongées (>30°C pour 5+ jours consécutifs) sont devenues plus fréquentes après 2003. Événements récents: 2017, 2019, 2022, 2023, 2024 — avec pics historiques supérieurs à 38°C enregistrés à Lugano en juillet 2023.',
    'alluvione-rischio': 'Les inondations au Tessin sont historiquement liées à des systèmes de précipitations intenses du SUD/SUD-EST (courants sirocco) entre octobre et novembre. Événements majeurs: 2000, 2014, 2018, 2024.',
    'ghiaccio-strade': 'La glace sur les routes frontalières est typique des mois novembre-mars, avec des pics lorsque la température chute rapidement sous zéro après des précipitations.',
  };
  const map = locale === 'it' ? it : locale === 'en' ? en : locale === 'de' ? de : fr;
  return map[alertId] ?? '';
}

function renderFaq(locale: Locale, _cfg: WeatherAlertConfig): string {
  const heading = locale === 'it' ? 'Domande frequenti' : locale === 'en' ? 'FAQ' : locale === 'de' ? 'Häufig gestellte Fragen' : 'Questions fréquentes';
  const items: Array<[string, string]> = locale === 'it'
    ? [
        ['Perché questa pagina è sempre attiva?', 'Le pagine allerta sono sempre indicizzate (always-live) anche quando l\'evento è dormiente. Questo evita il delay di indicizzazione di Google (2-7 giorni) che renderebbe le pagine flip-flop tra noindex/index inutili durante eventi brevi.'],
        ['Da dove vengono i dati?', 'Le allerte ufficiali sono il bollettino MeteoSwiss federale (alerts.meteoswiss.admin.ch). I dati meteo correnti vengono dal council di tre fonti (Open-Meteo, Met.no, MeteoSwiss observation) per ridondanza.'],
        ['Cosa fare se l\'allerta è attiva mentre devo partire?', 'Verificate la pagina del valico interessato (es. /tempi-attesa-frontiera/chiasso/) per condizioni stradali e webcam. Considerate alternative consigliate. Iscrivetevi alla newsletter per ricevere allerte commute via email.'],
      ]
    : locale === 'en'
    ? [
        ['Why is this page always active?', 'Alert pages are always indexed (always-live) even when the event is dormant. This avoids Google\'s indexing delay (2-7 days) that would make flip-flop pages useless during short events.'],
        ['Where does the data come from?', 'Official alerts come from MeteoSwiss federal bulletin (alerts.meteoswiss.admin.ch). Current weather data comes from a council of three sources (Open-Meteo, Met.no, MeteoSwiss observation) for redundancy.'],
        ['What should I do if the alert is active when I need to leave?', 'Check the relevant valico page (e.g. /tempi-attesa-frontiera/chiasso/) for road conditions and webcams. Consider recommended alternatives. Subscribe to the newsletter for email commute alerts.'],
      ]
    : locale === 'de'
    ? [
        ['Warum ist diese Seite immer aktiv?', 'Warnseiten sind immer indexiert (Always-Live) auch wenn das Ereignis ruht. Dies vermeidet Googles Indexierungsverzögerung (2-7 Tage), die Flip-Flop-Seiten während kurzer Ereignisse nutzlos machen würde.'],
        ['Woher kommen die Daten?', 'Offizielle Warnungen stammen aus dem MeteoSwiss-Bundesbulletin. Aktuelle Wetterdaten kommen aus einem Council aus drei Quellen für Redundanz.'],
        ['Was tun, wenn die Warnung aktiv ist, wenn ich abfahren muss?', 'Prüfen Sie die relevante Übergangsseite für Strassenbedingungen und Webcams. Berücksichtigen Sie empfohlene Alternativen. Abonnieren Sie den Newsletter für E-Mail-Pendler-Warnungen.'],
      ]
    : [
        ['Pourquoi cette page est-elle toujours active?', 'Les pages alerte sont toujours indexées (always-live) même lorsque l\'événement est dormant. Cela évite le délai d\'indexation de Google (2-7 jours) qui rendrait les pages flip-flop inutiles lors d\'événements courts.'],
        ['D\'où viennent les données?', 'Les alertes officielles proviennent du bulletin fédéral MeteoSwiss. Les données météo actuelles proviennent d\'un conseil de trois sources pour la redondance.'],
        ['Que faire si l\'alerte est active lorsque je dois partir?', 'Vérifiez la page du passage concerné pour les conditions routières et webcams. Considérez les alternatives recommandées. Abonnez-vous à la newsletter pour les alertes commute par e-mail.'],
      ];
  const itemsHtml = items.map(([q, a]) => `<details><summary>${escapeHtml(q)}</summary><p>${escapeHtml(a)}</p></details>`).join('');
  return `<section class="faq"><h2>${escapeHtml(heading)}</h2>${itemsHtml}</section>`;
}

function renderCta(locale: Locale, acquisitionSource: string): string {
  const ctaHeading = locale === 'it' ? 'Ricevi allerte commute via email' : locale === 'en' ? 'Get commute alerts by email' : locale === 'de' ? 'Pendler-Warnungen per E-Mail erhalten' : 'Recevez les alertes commute par e-mail';
  const ctaSub = locale === 'it' ? 'Newsletter trigger-based: ricevi una mail solo quando l\'evento è attivo.' : locale === 'en' ? 'Trigger-based newsletter: get an email only when the event is active.' : locale === 'de' ? 'Trigger-basierter Newsletter: erhalten Sie nur dann eine E-Mail, wenn das Ereignis aktiv ist.' : 'Newsletter déclenchée: recevez un e-mail uniquement lorsque l\'événement est actif.';
  return `<section class="cta-newsletter" data-acquisition-source="${escapeHtml(acquisitionSource)}">
<h2>${escapeHtml(ctaHeading)}</h2>
<p>${escapeHtml(ctaSub)}</p>
</section>`;
}

function attributionInline(locale: Locale, generatedAt?: string): string {
  const dataLabel = locale === 'it' ? 'Dati' : locale === 'en' ? 'Data' : locale === 'de' ? 'Daten' : 'Données';
  const updatedLabel = locale === 'it' ? 'Aggiornato' : locale === 'en' ? 'Updated' : locale === 'de' ? 'Aktualisiert' : 'Mis à jour';
  let stamp = '';
  if (generatedAt) {
    try {
      const d = new Date(generatedAt);
      if (!Number.isNaN(d.getTime())) {
        stamp = ` · <time datetime="${escapeHtml(generatedAt)}">${updatedLabel} ${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}</time>`;
      }
    } catch { /* ignore */ }
  }
  return `${dataLabel}: <a href="https://www.meteoswiss.admin.ch/" rel="noopener" target="_blank">MeteoSwiss</a> · <a href="https://open-meteo.com/" rel="noopener" target="_blank">Open-Meteo</a> · <a href="https://www.met.no/" rel="noopener" target="_blank">Weather forecast from MET Norway</a>${stamp} · <a href="https://creativecommons.org/licenses/by/4.0/" rel="noopener" target="_blank">CC-BY 4.0</a>`;
}

interface WrapOpts {
  locale: Locale;
  title: string;
  description: string;
  canonical: string;
  bodyHtml: string;
  generatedAt?: string;
}

function wrapHtml(opts: WrapOpts): string {
  const { locale, title, description, canonical, bodyHtml, generatedAt } = opts;
  const altLinks = LOCALES.map((l) => {
    const localePath = l === 'it' ? '' : `/${l}`;
    const tail = canonical.replace(/^https:\/\/frontaliereticino\.ch\/(?:[a-z]{2}\/)?(.*)$/, '$1');
    return `<link rel="alternate" hreflang="${l}" href="https://frontaliereticino.ch${localePath}/${tail}">`;
  }).join('');
  return `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<link rel="canonical" href="${canonical}">
${altLinks}
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:url" content="${canonical}">
<meta property="og:type" content="website">
<script type="application/ld+json">${JSON.stringify(jsonLd(locale, title, description, canonical, generatedAt))}</script>
</head>
<body>
<div id="root">
<main>
${bodyHtml}
</main>
</div>
<script>
window.addEventListener('DOMContentLoaded',function(){
var io=new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting){fetch('/data/weather-snapshot.json').then(function(r){return r.json()}).then(function(d){if(!d||!d.generatedAt)return;var t=document.querySelector('time[datetime]');if(t&&new Date(d.generatedAt)>new Date(t.dateTime)){t.dateTime=d.generatedAt}}).catch(function(){});io.disconnect()}})});var hero=document.querySelector('.alert-state');if(hero)io.observe(hero);
});
</script>
</body>
</html>`;
}

function jsonLd(locale: Locale, title: string, description: string, canonical: string, generatedAt?: string): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    inLanguage: locale,
    name: title,
    description,
    url: canonical,
    dateModified: generatedAt ?? new Date().toISOString(),
    isPartOf: {
      '@type': 'WebSite',
      name: 'Frontaliere Ticino',
      url: 'https://frontaliereticino.ch/',
    },
    publisher: {
      '@type': 'Organization',
      name: 'Frontaliere Ticino',
      url: 'https://frontaliereticino.ch/',
    },
  };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case "'": return '&#039;';
      default: return c;
    }
  });
}

function writeSitemap(rootDir: string, generatedAt?: string): void {
  const distDir = resolve(rootDir, 'dist');
  const sitemapFile = resolve(distDir, 'sitemap-weather-alerts.xml');
  const ts = generatedAt ?? new Date().toISOString();
  const urls: string[] = [];
  for (const locale of LOCALES) {
    const localePath = locale === 'it' ? '' : `/${locale}`;
    urls.push(`<url><loc>https://frontaliereticino.ch${localePath}/${HUB_SLUG[locale]}/</loc><lastmod>${ts}</lastmod></url>`);
    for (const cfg of WEATHER_ALERT_CONFIG) {
      urls.push(`<url><loc>https://frontaliereticino.ch${localePath}/${ALERTS_PARENT_BY_LOCALE[locale]}/${cfg.slug[locale]}/</loc><lastmod>${ts}</lastmod></url>`);
    }
  }
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
  writeFileSync(sitemapFile, xml, 'utf-8');
  console.log(`[weather-alert-pages] sitemap-weather-alerts.xml written (${urls.length} URLs)`);
}
