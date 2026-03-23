import { doc, getDoc, getFirestore } from 'firebase/firestore';
import { getApp } from '@/services/firebase';
import { buildNewsletter, FEATURED_TOOLS } from '@/services/newsletter-template.mjs';
import { matchJobsForSubscriber, getFallbackBriefing } from '@/services/newsletter-content.mjs';
import { reportCaughtError } from '@/services/errorReporter';

const BASE_URL = 'https://frontaliereticino.ch';

type NewsletterPreviewPayload = {
  subject: string;
};

function slugToTitle(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function getWeeklyFact() {
  const EPOCH = new Date('2025-01-06').getTime();
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  const weekIndex = Math.floor((Date.now() - EPOCH) / WEEK_MS) % 52;
  const FACTS = [
    { text: 'In Svizzera, il salario mediano \u00e8 di circa 6.665 CHF al mese.', source: 'UST' },
    { text: 'Oltre 78.000 frontalieri lavorano nel Canton Ticino.', source: 'USTAT' },
    { text: 'La franchigia per i nuovi frontalieri \u00e8 di 10.000 euro.', source: 'Accordo fiscale' },
    { text: 'Il tasso di disoccupazione in Ticino resta tra i pi\u00f9 osservati dai frontalieri.', source: 'SECO' },
    { text: 'Il 3\u00b0 pilastro 3a resta uno dei principali strumenti di ottimizzazione fiscale in Svizzera.', source: 'Admin.ch' },
  ];
  return FACTS[weekIndex % FACTS.length];
}

async function fetchExchangeRate(db: ReturnType<typeof getFirestore>) {
  try {
    const snapshot = await getDoc(doc(db, 'config', 'exchange_rate'));
    if (!snapshot.exists()) return null;
    const data = snapshot.data() || {};
    const normalize = (value: number) => (value > 0 && value < 0.8 ? 1 / value : value);
    return {
      rate: normalize(Number(data.rate || 0.94)),
      previousRate: normalize(Number(data.previousRate || data.rate || 0.94)),
    };
  } catch (e) {
    reportCaughtError(e, 'newsletterPreview.fetchExchangeRate');
    return null;
  }
}

export async function buildNewsletterPreviewHtml(payload: NewsletterPreviewPayload): Promise<string> {
  const app = await getApp();
  const db = getFirestore(app);

  const exchangeRate = await fetchExchangeRate(db);
  const fallbackExchange = exchangeRate || { rate: 1.0942, previousRate: 1.0885 };

  let jobs: any[] = [];
  try {
    const res = await fetch('/data/jobs.json');
    jobs = res.ok ? await res.json() : [];
  } catch (e) {
    reportCaughtError(e, 'newsletterPreview.fetchJobsData');
  }

  const matchedJobs = matchJobsForSubscriber({ locationInterest: null, sectorInterest: null }, jobs, 3);
  const toolIndex = Math.floor((Date.now() - new Date('2025-01-06').getTime()) / (7 * 24 * 60 * 60 * 1000)) % FEATURED_TOOLS.length;

  // Use the same article and totalJobs as the real email to match output exactly
  const defaultArticle = {
    title: 'Votazioni cantonali Ticino 2026: cosa cambia per i frontalieri',
    excerpt: 'SSR, imposizione individuale, fondo climatico: 4 temi su cui voti (o dovresti). Ecco cosa significa per il tuo portafoglio.',
    url: '/articoli-frontaliere/votazioni-imposizione-ticino-2026',
    badge: '🗳️ Voto 18 maggio',
  };

  return buildNewsletter({
    aiBriefing: getFallbackBriefing('it', fallbackExchange),
    exchangeRate: fallbackExchange,
    matchedJobs,
    totalJobs: jobs.length,
    article: defaultArticle,
    featuredTool: FEATURED_TOOLS[toolIndex],
    weeklyFact: getWeeklyFact(),
    locale: 'it',
    unsubscribeUrl: `${BASE_URL}/?action=unsubscribe&email=preview%40frontaliereticino.ch`,
    resubscribeUrl: `${BASE_URL}/?action=resubscribe&email=preview%40frontaliereticino.ch`,
    preheaderText: payload.subject || undefined,
  });
}
