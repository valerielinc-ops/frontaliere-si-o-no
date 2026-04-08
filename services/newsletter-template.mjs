/**
 * Newsletter HTML template — v3 (redesigned, dark hero, light body)
 *
 * Generates a branded, engaging, responsive HTML email.
 * Structure: dark hero (exchange rate) → editorial → metrics → jobs → article → tools → footer.
 * All links use direct https://frontaliereticino.ch/ URLs.
 * Autologin is handled externally by wrapping links with Firebase auth.
 */

const BASE_URL = 'https://frontaliereticino.ch';
const BRAND_ORANGE = '#f97316';
const BRAND_DARK = '#0f172a';
const DARK_CARD = '#1e293b';
const LIGHT_BG = '#f1f5f9';
const CARD_BG = '#f8fafc';
const WHITE = '#ffffff';
const TEXT_COLOR = '#334155';
const MUTED_COLOR = '#64748b';
const BORDER_COLOR = '#e2e8f0';
const GREEN = '#22c55e';
const RED = '#ef4444';

const NL_I18N = {
  it: {
    greeting: 'Buongiorno, frontaliere.',
    greetingSub: 'Ecco cosa succede ai tuoi soldi questa settimana.',
    rateCta: 'Confronta i tassi di cambio \u2192',
    editorialTitle: 'Parliamoci chiaro.',
    editorialBody1: 'Ogni settimana ti dicono che "il mercato \u00e8 volatile" e che "bisogna stare attenti". Grazie, utilissimo. Come dire a uno che sta annegando che l\u2019acqua \u00e8 bagnata.',
    editorialSign: '\u2014 Il team di Frontaliere Ticino, quelli che leggono i cedolini per hobby.',
    jobsTitle: 'Le offerte che non trovi su LinkedIn',
    jobsSub: 'Selezionate a mano, non da un algoritmo che pensa che tu voglia fare il "Growth Hacker" a Zugo.',
    jobsCta: 'Tutte le {n} offerte \u2192',
    articleTitle: 'Da leggere',
    toolsTitle: 'I tuoi attrezzi da frontaliere',
    toolsSub: 'Quelli che il tuo commercialista usa di nascosto (e ti fa pagare 200\u20ac a consulenza).',
    closerText: 'Ti è piaciuta questa email? Inoltrala a quel collega che chiede sempre "ma com\u2019è il cambio oggi?".',
    closerTag: 'Alla prossima. ☕',
    footerReason: 'Ricevi questa email perch\u00e9 ti sei iscritto su',
    unsubText: 'Non la vuoi pi\u00f9? {link} \u2014 giuro che non piangeremo. (Forse un po\u2019.)',
    unsubLink: 'Cancellati',
    copyright: 'Newsletter artigianale, 0% spam, 100% frontaliere',
  },
  en: {
    greeting: 'Good morning, frontaliere.',
    greetingSub: 'Here\u2019s what\u2019s happening to your money this week.',
    rateCta: 'Compare exchange rates \u2192',
    editorialTitle: 'Let\u2019s be honest.',
    editorialBody1: 'Every week they tell you "the market is volatile" and "you should be careful". Thanks, very helpful. Like telling someone who\u2019s drowning that water is wet.',
    editorialSign: '\u2014 The Frontaliere Ticino team, the ones who read payslips for fun.',
    jobsTitle: 'Jobs you won\u2019t find on LinkedIn',
    jobsSub: 'Hand-picked, not by an algorithm that thinks you want to be a "Growth Hacker" in Zug.',
    jobsCta: 'All {n} jobs \u2192',
    articleTitle: 'Worth reading',
    toolsTitle: 'Your frontaliere toolkit',
    toolsSub: 'The ones your accountant uses secretly (and charges you \u20ac200 per consultation).',
    closerText: 'Liked this email? Forward it to that colleague who always asks "what\u2019s the rate today?".',
    closerTag: 'See you next time. ☕',
    footerReason: 'You receive this email because you subscribed on',
    unsubText: 'Had enough? {link} \u2014 no hard feelings. (Maybe a little.)',
    unsubLink: 'Unsubscribe',
    copyright: 'Handcrafted newsletter, 0% spam, 100% frontaliere',
  },
  de: {
    greeting: 'Guten Morgen, Grenzg\u00e4nger.',
    greetingSub: 'Das passiert diese Woche mit deinem Geld.',
    rateCta: 'Wechselkurse vergleichen \u2192',
    editorialTitle: 'Mal ehrlich.',
    editorialBody1: 'Jede Woche sagen sie dir, der Markt sei volatil und man solle aufpassen. Danke, sehr hilfreich. Wie einem Ertrinkenden zu sagen, dass Wasser nass ist.',
    editorialSign: '\u2014 Das Frontaliere-Ticino-Team, die Leute, die Lohnzettel als Hobby lesen.',
    jobsTitle: 'Stellen, die du auf LinkedIn nicht findest',
    jobsSub: 'Von Hand ausgew\u00e4hlt, nicht von einem Algorithmus.',
    jobsCta: 'Alle {n} Stellen \u2192',
    articleTitle: 'Lesenswert',
    toolsTitle: 'Dein Grenzg\u00e4nger-Werkzeugkasten',
    toolsSub: 'Die Tools, die dein Steuerberater heimlich nutzt.',
    closerText: 'Hat dir diese E-Mail gefallen? Leite sie an den Kollegen weiter, der immer fragt "Wie steht der Kurs?".',
    closerTag: 'Bis zum nächsten Mal. ☕',
    footerReason: 'Du erh\u00e4ltst diese E-Mail, weil du dich angemeldet hast auf',
    unsubText: 'Genug? {link} \u2014 wir weinen nicht. (Vielleicht ein bisschen.)',
    unsubLink: 'Abmelden',
    copyright: 'Handgemachter Newsletter, 0% Spam, 100% Grenzg\u00e4nger',
  },
  fr: {
    greeting: 'Bonjour, frontalier.',
    greetingSub: 'Voici ce qui arrive \u00e0 ton argent cette semaine.',
    rateCta: 'Comparer les taux de change \u2192',
    editorialTitle: 'Soyons honn\u00eates.',
    editorialBody1: 'Chaque semaine on te dit que "le march\u00e9 est volatil" et qu\u2019il faut "faire attention". Merci, tr\u00e8s utile. Comme dire \u00e0 quelqu\u2019un qui se noie que l\u2019eau est mouill\u00e9e.',
    editorialSign: '\u2014 L\u2019\u00e9quipe Frontaliere Ticino, ceux qui lisent les fiches de paie pour le plaisir.',
    jobsTitle: 'Les offres que tu ne trouves pas sur LinkedIn',
    jobsSub: 'S\u00e9lectionn\u00e9es \u00e0 la main, pas par un algorithme.',
    jobsCta: 'Toutes les {n} offres \u2192',
    articleTitle: '\u00c0 lire',
    toolsTitle: 'Tes outils de frontalier',
    toolsSub: 'Ceux que ton comptable utilise en secret (et te facture 200\u20ac la consultation).',
    closerText: 'Tu as aimé cet email ? Transfère-le au collègue qui demande toujours "c\u2019est quoi le taux ?".',
    closerTag: 'À la prochaine. ☕',
    footerReason: 'Tu re\u00e7ois cet email car tu t\u2019es inscrit sur',
    unsubText: 'Tu n\u2019en veux plus ? {link} \u2014 on ne pleurera pas. (Un peu peut-\u00eatre.)',
    unsubLink: 'Se d\u00e9sinscrire',
    copyright: 'Newsletter artisanale, 0% spam, 100% frontalier',
  },
};

export function nlNormLocale(raw) {
  if (!raw) return 'it';
  const lang = String(raw).toLowerCase().split(/[-_]/)[0];
  return ['en', 'de', 'fr'].includes(lang) ? lang : 'it';
}

function nlT(locale, key) {
  const lang = nlNormLocale(locale);
  return NL_I18N[lang]?.[key] || NL_I18N.it[key] || key;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function directUrl(path) {
  if (/^https?:\/\//i.test(path)) return path;
  return `${BASE_URL}${path.startsWith('/') ? path : '/' + path}`;
}

function formatDate(locale) {
  const now = new Date();
  const localeMap = { it: 'it-IT', en: 'en-GB', de: 'de-CH', fr: 'fr-CH' };
  return now.toLocaleDateString(localeMap[locale] || 'it-IT', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
}

function getWeekNumber() {
  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 1);
  const diff = now - start;
  return Math.ceil((diff / 86400000 + start.getDay() + 1) / 7);
}

// Fallback: week-based issue number (used only when real count is unavailable)
function getIssueNumberFallback() {
  const now = new Date();
  const weeksSinceBase = Math.floor((now - new Date(2025, 0, 6)) / (7 * 86400000));
  return Math.max(1, weeksSinceBase + 1);
}

export const FEATURED_TOOLS = [
  {
    icon: '\ud83d\udcb0', title: 'Calcola Stipendio', popular: true,
    description: 'Dal lordo al netto in 5 secondi. Con AVS, LPP, imposta alla fonte e conversione CHF/EUR.',
    toolUrl: '/calcola-stipendio',
  },
  {
    icon: '\ud83c\udfe5', title: 'Confronto LAMal',
    description: '14 assicuratori, tutti i modelli, tutte le franchigie. Trova il premio pi\u00f9 basso per il tuo profilo.',
    toolUrl: '/compara-servizi/confronta-casse-malati',
  },
  {
    icon: '\ud83d\udccb', title: 'Guida 730',
    description: 'Step by step per la dichiarazione dei redditi italiana. Franchigia, quadro RC, deduzioni \u2014 tutto spiegato senza legalese.',
    toolUrl: '/tasse-e-pensione/dichiarazione-redditi',
  },
  {
    icon: '\ud83d\udcb1', title: 'Cambio Valuta',
    description: 'Tasso aggiornato ogni ora + confronto tra banche e servizi. Perch\u00e9 0.2% di differenza su 60k sono 120\u20ac.',
    toolUrl: '/compara-servizi/cambio-franco-euro',
  },
];

// ── Section renderers ─────────────────────────────────────────

function renderTopBar(locale, issueNumberOverride) {
  const weekNum = getWeekNumber();
  const issueNum = issueNumberOverride || getIssueNumberFallback();
  const now = new Date();
  const monthNames = {
    it: ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'],
    en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
    de: ['Jan', 'Feb', 'M\u00e4r', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'],
    fr: ['jan', 'f\u00e9v', 'mar', 'avr', 'mai', 'jun', 'jul', 'ao\u00fb', 'sep', 'oct', 'nov', 'd\u00e9c'],
  };
  const month = (monthNames[locale] || monthNames.it)[now.getMonth()];
  return `
    <tr><td class="topbar-pad" style="background:${BRAND_DARK};padding:10px 28px;">
      <table width="100%" cellpadding="0" cellspacing="0"><tr>
        <td style="font-size:15px;font-weight:900;color:${BRAND_ORANGE};letter-spacing:-0.3px;">Frontaliere Ticino</td>
        <td align="right" style="font-size:11px;color:${MUTED_COLOR};">#${issueNum} \u00b7 ${now.getDate()} ${month}. ${now.getFullYear()}</td>
      </tr></table>
    </td></tr>`;
}

function renderHeroExchangeRate({ rate, previousRate, locale }) {
  const diff = rate - previousRate;
  const pct = previousRate > 0 ? Math.abs((diff / previousRate) * 100).toFixed(1) : '0.0';
  const isDown = diff < -0.0005;
  const isUp = diff > 0.0005;
  const arrow = isUp ? '\u25b2' : isDown ? '\u25bc' : '\u25cf';
  const arrowColor = isUp ? GREEN : isDown ? RED : MUTED_COLOR;
  const sign = isDown ? '-' : isUp ? '+' : '';

  // Calculate savings impact on 5000 CHF
  const monthlyLoss = Math.abs(diff * 5000);
  const yearlyLoss = Math.round(monthlyLoss * 52);

  return `
    <tr><td class="section-pad" style="background:${BRAND_DARK};color:#fff;padding:32px 28px 28px;text-align:center;">
      <div style="font-size:13px;text-transform:uppercase;letter-spacing:2px;color:${BRAND_ORANGE};font-weight:700;margin-bottom:6px;">\u26a1 Aggiornamento in tempo reale</div>
      <div style="font-size:28px;font-weight:800;margin:0 0 4px;line-height:1.2;color:#fff;">${nlT(locale, 'greeting')}</div>
      <div style="font-size:14px;color:#94a3b8;margin:0 0 20px;">${nlT(locale, 'greetingSub')}</div>

      <!--[if mso]><table cellpadding="0" cellspacing="0" align="center"><tr><td style="background:#1e293b;border-radius:16px;padding:20px 36px;"><![endif]-->
      <a href="${directUrl('/compara-servizi/cambio-franco-euro')}" style="text-decoration:none;display:inline-block;">
      <div class="rate-box" style="display:inline-block;background:linear-gradient(135deg,#1e293b,#334155);border-radius:16px;padding:20px 36px;margin:8px 0 16px;">
        <div style="font-size:12px;color:#94a3b8;text-transform:uppercase;letter-spacing:1px;">Tasso CHF \u2192 EUR</div>
        <div class="hero-rate" style="font-size:52px;font-weight:900;color:${BRAND_ORANGE};letter-spacing:-1px;line-height:1.1;">${rate.toFixed(4)}</div>
        <div style="font-size:14px;margin-top:4px;color:${arrowColor};">${arrow} ${sign}${pct}% vs settimana scorsa</div>
      </div>
      </a>
      <!--[if mso]></td></tr></table><![endif]-->

      ${monthlyLoss > 1 ? `
      <div style="background:rgba(249,115,22,0.12);border:1px solid rgba(249,115,22,0.3);border-radius:10px;padding:12px 18px;margin-top:14px;font-size:13px;color:#fdba74;">
        Su uno stipendio di <strong style="color:${BRAND_ORANGE};font-size:15px;">5'000 CHF</strong>, questa settimana ${isDown ? 'perdi' : 'guadagni'} <strong style="color:${BRAND_ORANGE};font-size:15px;">\u20ac${Math.round(monthlyLoss)}</strong> ${isDown ? 'in pi\u00f9' : 'in pi\u00f9'} rispetto a luned\u00ec scorso. ${yearlyLoss > 50 ? `In un anno fa <strong style="color:${BRAND_ORANGE};font-size:15px;">\u20ac${yearlyLoss}</strong>. Forse vale la pena controllare, no?` : ''}
      </div>` : ''}

      <div style="margin-top:12px;font-size:14px;color:#e2e8f0;line-height:1.5;">Ma se confronti dove cambi, puoi recuperarne <strong style="color:${BRAND_ORANGE};">300\u2011500\u20ac</strong>. Non sono noccioline.</div>

      <div style="margin-top:16px;">
        <a href="${directUrl('/compara-servizi/cambio-franco-euro')}" style="display:inline-block;background:${BRAND_ORANGE};color:#fff;font-weight:700;font-size:14px;text-decoration:none;padding:12px 28px;border-radius:8px;">${nlT(locale, 'rateCta')}</a>
      </div>
    </td></tr>`;
}

function renderEditorial(locale, aiBriefing, totalJobs) {
  const jobCount = totalJobs || 0;
  const pStyle = `font-size:14px;color:${TEXT_COLOR};line-height:1.65;margin:0 0 14px;`;
  // If AI briefing is provided, inject inline styles into its <p> tags
  const bodyContent = aiBriefing
    ? aiBriefing
        .replace(/<p>/gi, `<p style="${pStyle}">`)
        .replace(/<p style="[^"]*">/gi, `<p style="${pStyle}">`)
    : `<p style="${pStyle}">${nlT(locale, 'editorialBody1')}</p>
       <p style="${pStyle}">Noi preferiamo i numeri. Quelli veri, quelli che trovi in busta paga. Questa settimana: il cambio scende (di nuovo)${jobCount > 0 ? `, le offerte di lavoro salgono a <strong>${jobCount}</strong>` : ''}, e c\u2019\u00e8 una votazione che forse ti sei perso tra un cappuccino e la coda a Brogeda.</p>`;

  return `
    <tr><td class="section-pad" style="background:${WHITE};padding:28px 28px 8px;">
      <div style="font-size:20px;font-weight:800;color:${BRAND_DARK};margin:0 0 12px;">${nlT(locale, 'editorialTitle')}</div>
      ${bodyContent}
      <div style="font-size:13px;color:${MUTED_COLOR};font-style:italic;margin-top:8px;">${nlT(locale, 'editorialSign')}</div>
    </td></tr>`;
}

function renderMetrics(totalJobs, metrics) {
  const m = metrics || {};
  const unemploymentRate = m.unemploymentRate || '2.8%';
  const unemploymentLabel = m.unemploymentLabel || 'Disoccupazione CH';
  const lamalPremium = m.lamalPremium || 'CHF 467';
  const lamalLabel = m.lamalLabel || 'Premio LAMal Lugano';

  return `
    <tr><td class="section-pad" style="background:${WHITE};padding:8px 28px 8px;">
      <!--[if mso]><table width="100%" cellpadding="0" cellspacing="0"><tr><td width="33%" valign="top"><![endif]-->
      <table width="100%" cellpadding="0" cellspacing="0"><tr class="metric-row">
        <td width="33%" style="padding:0 4px 0 0;">
          <a href="${directUrl('/cerca-lavoro-ticino')}" style="text-decoration:none;display:block;">
            <div style="background:${CARD_BG};border:1px solid ${BORDER_COLOR};border-radius:12px;padding:14px 12px;text-align:center;">
              <div style="font-size:22px;margin-bottom:4px;">\ud83d\udcbc</div>
              <div style="font-size:20px;font-weight:800;color:${BRAND_DARK};">${totalJobs || '200+'}</div>
              <div style="font-size:11px;color:${MUTED_COLOR};text-transform:uppercase;letter-spacing:0.5px;margin-top:2px;">Offerte lavoro</div>
            </div>
          </a>
        </td>
        <!--[if mso]></td><td width="33%" valign="top"><![endif]-->
        <td width="33%" style="padding:0 4px;">
          <a href="${directUrl('/statistiche')}" style="text-decoration:none;display:block;">
            <div style="background:${CARD_BG};border:1px solid ${BORDER_COLOR};border-radius:12px;padding:14px 12px;text-align:center;">
              <div style="font-size:22px;margin-bottom:4px;">\ud83d\udcca</div>
              <div style="font-size:20px;font-weight:800;color:${BRAND_DARK};">${unemploymentRate}</div>
              <div style="font-size:11px;color:${MUTED_COLOR};text-transform:uppercase;letter-spacing:0.5px;margin-top:2px;">${unemploymentLabel}</div>
            </div>
          </a>
        </td>
        <!--[if mso]></td><td width="33%" valign="top"><![endif]-->
        <td width="33%" style="padding:0 0 0 4px;">
          <a href="${directUrl('/compara-servizi/confronta-casse-malati')}" style="text-decoration:none;display:block;">
            <div style="background:${CARD_BG};border:1px solid ${BORDER_COLOR};border-radius:12px;padding:14px 12px;text-align:center;">
              <div style="font-size:22px;margin-bottom:4px;">\ud83c\udfe5</div>
              <div style="font-size:20px;font-weight:800;color:${BRAND_DARK};">${lamalPremium}</div>
              <div style="font-size:11px;color:${MUTED_COLOR};text-transform:uppercase;letter-spacing:0.5px;margin-top:2px;">${lamalLabel}</div>
            </div>
          </a>
        </td>
      </tr></table>
      <!--[if mso]></td></tr></table><![endif]-->
    </td></tr>`;
}

function renderDivider() {
  return `<tr><td class="section-pad" style="padding:12px 28px;"><div style="border-top:1px solid ${BORDER_COLOR};"></div></td></tr>`;
}

function renderJobs(matchedJobs, locale, totalJobs) {
  if (!matchedJobs || matchedJobs.length === 0) return '';
  const jobCount = totalJobs || matchedJobs.length;
  const jobCards = matchedJobs.slice(0, 4).map((job, i) => {
    const initial = (job.company || '?')[0].toUpperCase();
    const tags = [];
    if (i === 0) tags.push(`<span style="font-size:10px;background:rgba(239,68,68,0.2);color:#fca5a5;padding:2px 8px;border-radius:6px;text-transform:uppercase;letter-spacing:0.5px;font-weight:600;">\ud83d\udd25 Pi\u00f9 cliccata</span>`);
    if (job.contract) tags.push(`<span style="font-size:10px;background:rgba(249,115,22,0.15);color:#fdba74;padding:2px 8px;border-radius:6px;text-transform:uppercase;letter-spacing:0.5px;font-weight:600;">${escapeHtml(job.contract)}</span>`);
    if (job.location) tags.push(`<span style="font-size:10px;background:rgba(249,115,22,0.15);color:#fdba74;padding:2px 8px;border-radius:6px;text-transform:uppercase;letter-spacing:0.5px;font-weight:600;">${escapeHtml(job.location)}</span>`);

    return `
      <tr><td style="padding:0 0 10px;">
        <a href="${directUrl(job.url)}" style="text-decoration:none;display:block;">
          <table width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND_DARK};border-radius:12px;">
            <tr>
              <td width="58" style="padding:16px 0 16px 18px;vertical-align:middle;">
                <div style="width:44px;height:44px;border-radius:10px;background:linear-gradient(135deg,#1e293b,#334155);text-align:center;line-height:44px;font-size:18px;font-weight:800;color:${BRAND_ORANGE};">${initial}</div>
              </td>
              <td style="padding:16px 18px 16px 14px;vertical-align:middle;">
                <div class="job-title" style="font-size:14px;font-weight:700;color:#f1f5f9;margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(job.title)}</div>
                <div style="font-size:12px;color:#94a3b8;margin-top:2px;">${escapeHtml(job.company)}${job.location ? ' \u00b7 ' + escapeHtml(job.location) : ''}</div>
                ${tags.length > 0 ? `<div style="margin-top:4px;">${tags.join(' ')}</div>` : ''}
              </td>
            </tr>
          </table>
        </a>
      </td></tr>`;
  }).join('');

  const ctaText = nlT(locale, 'jobsCta').replace('{n}', String(jobCount));

  return `
    <tr><td class="section-pad" style="background:${WHITE};padding:8px 28px 20px;">
      <table width="100%" cellpadding="0" cellspacing="0">
        ${jobCards}
        <tr><td style="text-align:center;padding-top:14px;">
          <a href="${directUrl('/cerca-lavoro-ticino')}" style="display:inline-block;background:transparent;border:2px solid ${BRAND_ORANGE};color:${BRAND_ORANGE};font-weight:700;font-size:13px;text-decoration:none;padding:11px 28px;border-radius:8px;">${ctaText}</a>
        </td></tr>
      </table>
    </td></tr>`;
}

function renderQuote(fact) {
  const text = fact?.text || 'La cosa pi\u00f9 bella di vivere al confine \u00e8 che puoi scegliere in quale Paese avere il mal di testa fiscale.';
  const source = fact?.source || 'Anonimo frontaliere, probabilmente in coda a Brogeda';
  return `
    <tr><td class="section-pad" style="padding:8px 28px 16px;">
      <div style="background:linear-gradient(135deg,${BRAND_ORANGE},#ea580c);border-radius:12px;padding:20px 22px;text-align:center;">
        <div style="font-size:16px;font-weight:700;color:#fff;line-height:1.4;">\u201c${escapeHtml(text)}\u201d</div>
        <div style="font-size:11px;color:rgba(255,255,255,0.7);margin-top:6px;">\u2014 ${escapeHtml(source)}</div>
      </div>
    </td></tr>`;
}

// FRO-275: Emoji per articolo basate su categoria/titolo del contenuto
const ARTICLE_EMOJI_MAP = {
  fiscale:     '💰 📊 🇨🇭',
  tasse:       '💰 📊 🧾',
  lavoro:      '💼 🏢 🇨🇭',
  pratico:     '📋 ✅ 🇨🇭',
  pensione:    '🏦 📈 🇨🇭',
  sanita:      '🏥 💊 🇨🇭',
  novita:      '🗞️ ⚡ 🇨🇭',
  votazioni:   '🗳️ 🏔️ 🇨🇭',
  cambio:      '💱 📉 🇨🇭',
  traffico:    '🚗 🛃 🇨🇭',
  assicurazione:'🛡️ 📋 🇨🇭',
  default:     '📰 🏔️ 🇨🇭',
};

function deriveArticleEmoji(article) {
  if (!article) return ARTICLE_EMOJI_MAP.default;
  const text = `${article.title || ''} ${article.excerpt || ''} ${article.badge || ''} ${article.category || ''}`.toLowerCase();
  for (const [key, emoji] of Object.entries(ARTICLE_EMOJI_MAP)) {
    if (key === 'default') continue;
    if (text.includes(key)) return emoji;
  }
  // Keyword fallback
  if (text.match(/impost|irpef|730|dichiarazion/)) return ARTICLE_EMOJI_MAP.fiscale;
  if (text.match(/stipendio|salario|contratt/)) return ARTICLE_EMOJI_MAP.lavoro;
  if (text.match(/avs|lpp|pilastro|rendita/)) return ARTICLE_EMOJI_MAP.pensione;
  if (text.match(/lamal|cassa malat|medic/)) return ARTICLE_EMOJI_MAP.sanita;
  if (text.match(/vot|referendum|iniziativa/)) return ARTICLE_EMOJI_MAP.votazioni;
  if (text.match(/chf|eur|franco|cambio/)) return ARTICLE_EMOJI_MAP.cambio;
  if (text.match(/dogana|valico|frontalier.*auto/)) return ARTICLE_EMOJI_MAP.traffico;
  return ARTICLE_EMOJI_MAP.default;
}

function renderArticle(article, locale) {
  if (!article) return '';
  const emoji = deriveArticleEmoji(article);
  return `
    <tr><td class="section-pad" style="background:${WHITE};padding:0 28px 8px;">
      <a href="${directUrl(article.url)}" style="text-decoration:none;display:block;">
        <div style="background:${CARD_BG};border:1px solid ${BORDER_COLOR};border-radius:14px;overflow:hidden;">
          <div style="width:100%;height:200px;background:linear-gradient(135deg,#1e293b 0%,${BRAND_DARK} 50%,${BRAND_ORANGE} 100%);text-align:center;line-height:200px;">
            <span style="font-size:56px;letter-spacing:8px;">${emoji}</span>
          </div>
          <div style="padding:18px 20px;">
            ${article.badge ? `<span style="display:inline-block;background:#fef3c7;color:#92400e;font-size:10px;font-weight:700;padding:3px 10px;border-radius:6px;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;">${escapeHtml(article.badge)}</span>` : ''}
            <div style="font-size:17px;font-weight:800;color:${BRAND_DARK};margin:0 0 8px;line-height:1.3;">${escapeHtml(article.title)}</div>
            <div style="font-size:13px;color:#475569;line-height:1.55;margin:0 0 14px;">${escapeHtml(article.excerpt)}</div>
            <span style="display:inline-block;background:${BRAND_DARK};color:#fff;font-weight:700;font-size:13px;padding:10px 22px;border-radius:8px;">Leggi l\u2019analisi completa \u2192</span>
          </div>
        </div>
      </a>
    </td></tr>`;
}

function renderTools(locale) {
  const tools = FEATURED_TOOLS;
  const toolCards = tools.map((tool, i) => {
    const isFeatured = tool.popular;
    const bg = isFeatured ? '#fff7ed' : CARD_BG;
    const border = isFeatured ? BRAND_ORANGE : BORDER_COLOR;
    const nameColor = isFeatured ? '#c2410c' : BRAND_DARK;
    const popular = isFeatured ? `<span style="font-size:9px;background:${BRAND_ORANGE};color:#fff;padding:2px 6px;border-radius:4px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;margin-left:4px;vertical-align:middle;">\u2605 #1</span>` : '';
    return `
      <td width="50%" class="tool-cell" style="padding:${i % 2 === 0 ? '0 5px 10px 0' : '0 0 10px 5px'};vertical-align:top;">
        <a href="${directUrl(tool.toolUrl)}" style="text-decoration:none;display:block;">
          <div style="background:${bg};border:1px solid ${border};border-radius:12px;padding:16px 14px;">
            <div style="font-size:24px;margin-bottom:6px;">${tool.icon}</div>
            <div style="font-size:13px;font-weight:700;color:${nameColor};margin:0 0 4px;">${escapeHtml(tool.title)}${popular}</div>
            <div style="font-size:11px;color:${MUTED_COLOR};line-height:1.4;margin:0;">${escapeHtml(tool.description)}</div>
          </div>
        </a>
      </td>`;
  });
  // Build 2-column rows
  const rows = [];
  for (let i = 0; i < toolCards.length; i += 2) {
    rows.push(`<tr class="tool-row">${toolCards[i]}${toolCards[i + 1] || '<td></td>'}</tr>`);
  }
  return `
    <tr><td class="section-pad" style="background:${WHITE};padding:0 28px 24px;">
      <table width="100%" cellpadding="0" cellspacing="0">
        ${rows.join('')}
      </table>
    </td></tr>`;
}

function renderCloser(locale) {
  return `
    <tr><td class="section-pad" style="background:${WHITE};padding:0 28px 20px;">
      <div style="background:#f1f5f9;border-radius:12px;padding:18px 20px;text-align:center;">
        <div style="font-size:14px;color:${TEXT_COLOR};line-height:1.5;margin:0 0 8px;">${nlT(locale, 'closerText')}</div>
        <div style="font-size:12px;color:${BRAND_ORANGE};font-weight:700;">${nlT(locale, 'closerTag')}</div>
      </div>
    </td></tr>`;
}

function renderFooter(locale, unsubscribeUrl) {
  const unsubLink = `<a href="${unsubscribeUrl || '{{UNSUBSCRIBE_URL}}'}" style="color:${BRAND_ORANGE};text-decoration:underline;">${nlT(locale, 'unsubLink')}</a>`;
  const unsubLine = nlT(locale, 'unsubText').replace('{link}', unsubLink);
  return `
    <tr><td class="footer-pad" style="background:${BRAND_DARK};padding:28px;text-align:center;">
      <div style="margin-bottom:12px;">
        <a href="https://www.facebook.com/profile.php?id=61588174947294" style="display:inline-block;margin:0 6px;font-size:18px;text-decoration:none;">\ud83d\udcd8</a>
        <a href="https://www.linkedin.com/company/frontaliere-ticino" style="display:inline-block;margin:0 6px;font-size:18px;text-decoration:none;">\ud83d\udcbc</a>
        <a href="${BASE_URL}" style="display:inline-block;margin:0 6px;font-size:18px;text-decoration:none;">\ud83c\udf10</a>
      </div>
      <div style="font-size:12px;color:${MUTED_COLOR};margin:4px 0;">${nlT(locale, 'footerReason')} <a href="${BASE_URL}" style="color:${BRAND_ORANGE};text-decoration:underline;">frontaliereticino.ch</a></div>
      <div style="font-size:12px;color:${MUTED_COLOR};margin:4px 0;">${unsubLine}</div>
      <div style="font-size:12px;color:#475569;margin-top:12px;">\u00a9 ${new Date().getFullYear()} Frontaliere Ticino \u00b7 ${nlT(locale, 'copyright')}</div>
    </td></tr>`;
}

/**
 * Build the newsletter HTML.
 * @param {object} data
 * @param {string}  [data.aiBriefing]    — AI-generated personalized briefing (HTML with <p> tags)
 * @param {object}  [data.exchangeRate]  — { rate, previousRate }
 * @param {Array}   [data.matchedJobs]   — [{ title, url, company, location, contract }]
 * @param {number}  [data.totalJobs]     — Total number of available jobs
 * @param {object}  [data.featuredTool]  — (legacy, ignored in v3 — tools grid is built-in)
 * @param {object}  [data.weeklyFact]    — { text, source }
 * @param {object}  [data.article]       — { title, excerpt, url, badge }
 * @param {object}  [data.metrics]       — { unemploymentRate, unemploymentLabel, lamalPremium, lamalLabel }
 * @param {string}  [data.locale]        — 'it' | 'en' | 'de' | 'fr'
 * @param {string}  [data.unsubscribeUrl]
 * @param {string}  [data.resubscribeUrl]
 * @param {string}  [data.preheaderText]
 * @returns {string}
 */
export function buildNewsletter(data) {
  const locale = nlNormLocale(data.locale);
  const dateStr = formatDate(locale);
  const preheader = data.preheaderText || (data.exchangeRate
    ? 'CHF/EUR ' + data.exchangeRate.rate.toFixed(4) + ' \u00b7 ' + dateStr
    : dateStr);

  const totalJobs = data.totalJobs || 0;

  let html = '';

  // 1. Top bar
  html += renderTopBar(locale, data.issueNumber);

  // 2. Hero exchange rate
  if (data.exchangeRate) html += renderHeroExchangeRate({ ...data.exchangeRate, locale });

  // 3. Editorial (AI briefing or fallback)
  html += renderEditorial(locale, data.aiBriefing, totalJobs);

  // 4. Dashboard metrics
  html += renderMetrics(totalJobs, data.metrics);

  // 5. Divider
  html += renderDivider();

  // 6. Section header: Jobs (only if there are matched jobs)
  if (data.matchedJobs && data.matchedJobs.length > 0) {
    html += `<tr><td class="section-pad" style="background:${WHITE};padding:24px 28px 8px;">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:2px;color:${BRAND_ORANGE};font-weight:700;margin:0 0 2px;">\ud83d\udcbc Lavoro</div>
      <div style="font-size:18px;font-weight:800;color:${BRAND_DARK};margin:0;">${nlT(locale, 'jobsTitle')}</div>
      <div style="font-size:13px;color:${MUTED_COLOR};margin:4px 0 0;">${nlT(locale, 'jobsSub')}</div>
    </td></tr>`;
    html += renderJobs(data.matchedJobs, locale, totalJobs);
  }

  // 7. Quote (from weekly fact or default)
  html += renderQuote(data.weeklyFact);

  // 8. Divider
  html += renderDivider();

  // 9. Article section
  if (data.article) {
    html += `<tr><td class="section-pad" style="background:${WHITE};padding:24px 28px 8px;">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:2px;color:${BRAND_ORANGE};font-weight:700;margin:0 0 2px;">\ud83d\udcf0 ${nlT(locale, 'articleTitle')}</div>
    </td></tr>`;
    html += renderArticle(data.article, locale);
  }

  // 10. Divider
  html += renderDivider();

  // 11. Section header: Tools
  html += `<tr><td class="section-pad" style="background:${WHITE};padding:24px 28px 8px;">
    <div style="font-size:11px;text-transform:uppercase;letter-spacing:2px;color:${BRAND_ORANGE};font-weight:700;margin:0 0 2px;">\ud83e\uddf0 Strumenti</div>
    <div style="font-size:18px;font-weight:800;color:${BRAND_DARK};margin:0;">${nlT(locale, 'toolsTitle')}</div>
    <div style="font-size:13px;color:${MUTED_COLOR};margin:4px 0 0;">${nlT(locale, 'toolsSub')}</div>
  </td></tr>`;
  html += renderTools(locale);

  // 12. Closer
  html += renderCloser(locale);

  // 13. Footer
  html += renderFooter(locale, data.unsubscribeUrl);

  return `<!DOCTYPE html>
<html lang="${locale}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>Frontaliere Weekly</title>
  <!--[if mso]><style>table{border-collapse:collapse;}td{padding:0;}</style><![endif]-->
  <style>
    body{margin:0;padding:0;background:${LIGHT_BG};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;-webkit-text-size-adjust:100%;}
    table{border-collapse:collapse;}
    img{border:0;max-width:100%;}
    .preheader{display:none!important;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;}
    @media only screen and (max-width:620px){
      .outer-table{width:100%!important;}
      .hero-rate{font-size:40px!important;}
      .rate-box{padding:16px 20px!important;}
      .section-pad{padding-left:16px!important;padding-right:16px!important;}
      .topbar-pad{padding-left:16px!important;padding-right:16px!important;}
      .metric-card{display:block!important;width:100%!important;padding:0 0 8px 0!important;}
      .metric-row td{display:block!important;width:100%!important;padding:0 0 8px 0!important;}
      .tool-cell{display:block!important;width:100%!important;padding:0 0 10px 0!important;}
      .tool-row td{display:block!important;width:100%!important;padding:0 0 10px 0!important;}
      .job-title{white-space:normal!important;}
      .footer-pad{padding:20px 16px!important;}
    }
  </style>
</head>
<body>
  <div class="preheader">${escapeHtml(preheader)}&nbsp;\u200c\u200c\u200c\u200c\u200c\u200c\u200c</div>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:${LIGHT_BG};">
    <tr><td align="center" style="padding:0;">
      <table width="620" cellpadding="0" cellspacing="0" style="width:100%;max-width:620px;background:${WHITE};">
        ${html}
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}
