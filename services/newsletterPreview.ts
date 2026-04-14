import { doc, getDoc, getFirestore } from 'firebase/firestore';
import { getApp, getConfigValue } from '@/services/firebase';
import { buildNewsletter, FEATURED_TOOLS } from '@/services/newsletter-template.mjs';
import {
 matchJobsForSubscriber,
 getFallbackBriefing,
 buildBriefingPrompt,
 buildSubjectPrompt,
 FALLBACK_SUBJECT,
} from '@/services/newsletter-content.mjs';
import { reportCaughtError } from '@/services/errorReporter';

const BASE_URL = 'https://frontaliereticino.ch';
const GEMINI_MODEL = 'gemini-2.0-flash-lite';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

export type NewsletterPreviewPayload = {
 subject: string;
};

export type NewsletterPreviewResult = {
 html: string;
 /** AI-generated subject (or fallback if AI failed) */
 subject: string;
};

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

/**
 * Call Gemini API directly from the browser for preview AI content.
 * Returns null on any failure — callers must provide fallback.
 */
async function callGeminiForPreview(
 systemPrompt: string,
 userPrompt: string,
 maxTokens: number,
 temperature: number,
): Promise<string | null> {
 try {
 const apiKey = await getConfigValue('GEMINI_API_KEY');
 if (!apiKey) return null;

 const res = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
 method: 'POST',
 headers: { 'Content-Type': 'application/json' },
 body: JSON.stringify({
 systemInstruction: { parts: [{ text: systemPrompt }] },
 contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
 generationConfig: { maxOutputTokens: maxTokens, temperature },
 }),
 });
 if (!res.ok) return null;

 const data = await res.json();
 const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
 return text || null;
 } catch {
 return null;
 }
}

/**
 * Generate AI briefing for preview. Falls back to static briefing.
 */
async function generatePreviewBriefing(
 exchangeRate: { rate: number; previousRate: number },
 matchedJobs: any[],
 weeklyFact: any,
 featuredTool: any,
): Promise<string> {
 const ctx = {
 subscriber: { locale: 'it', preferences: { jobs: true, exchangeRate: true, taxUpdates: true } },
 exchangeRate,
 exchangeInsight: null, // Not available in preview (requires Firestore history)
 matchedJobs,
 weeklyFact,
 featuredTool,
 };
 const prompts = buildBriefingPrompt(ctx);
 const result = await callGeminiForPreview(prompts.system, prompts.user, 500, 0.7);

 if (result) {
 // Ensure output has <p> tags (same cleanup as send-newsletter.mjs)
 if (!result.includes('<p')) {
 return result.split('\n\n').filter(Boolean).map((p: string) =>
 `<p style="font-size:14px;color:#334155;line-height:1.65;margin:0 0 14px;">${p.trim()}</p>`
 ).join('');
 }
 return result;
 }
 return getFallbackBriefing('it', exchangeRate);
}

/**
 * Generate AI subject for preview. Falls back to FALLBACK_SUBJECT.
 */
async function generatePreviewSubject(
 exchangeRate: { rate: number; previousRate: number },
 matchedJobs: any[],
 briefingHtml: string,
): Promise<string> {
 // Extract briefing summary (strip HTML, first 100 chars)
 const briefingSummary = briefingHtml
 .replace(/<[^>]+>/g, ' ')
 .replace(/\s+/g, ' ')
 .trim()
 .slice(0, 100);

 const ctx = {
 subscriber: { locale: 'it', preferences: {} },
 exchangeRate,
 matchedJobs,
 briefingSummary,
 };
 const prompts = buildSubjectPrompt(ctx);
 const result = await callGeminiForPreview(prompts.system, prompts.user, 80, 0.8);

 if (result) {
 // Clean up: strip quotes and markdown artifacts (same as send-newsletter.mjs)
 return result.replace(/^["'`]+|["'`]+$/g, '').trim().slice(0, 80);
 }
 return (FALLBACK_SUBJECT as Record<string, string>).it;
}

export async function buildNewsletterPreviewHtml(
 payload: NewsletterPreviewPayload,
): Promise<NewsletterPreviewResult> {
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

 const matchedJobs = matchJobsForSubscriber({ locationInterest: null, sectorInterest: null }, jobs, 5);
 const toolIndex = Math.floor((Date.now() - new Date('2025-01-06').getTime()) / (7 * 24 * 60 * 60 * 1000)) % FEATURED_TOOLS.length;
 const weeklyFact = getWeeklyFact();
 const featuredTool = FEATURED_TOOLS[toolIndex];

 // Use the same article as the real email
 const defaultArticle = {
 title: 'Votazioni cantonali Ticino 2026: cosa cambia per i frontalieri',
 excerpt: 'SSR, imposizione individuale, fondo climatico: 4 temi su cui voti (o dovresti). Ecco cosa significa per il tuo portafoglio.',
 url: '/articoli-frontaliere/votazioni-imposizione-ticino-2026',
 badge: '\ud83d\uddf3\ufe0f Voto 18 maggio',
 };

 // Generate AI briefing (or fallback)
 const aiBriefing = await generatePreviewBriefing(fallbackExchange, matchedJobs, weeklyFact, featuredTool);

 // Generate AI subject (or fallback) — uses briefing as input
 const subject = payload.subject || await generatePreviewSubject(fallbackExchange, matchedJobs, aiBriefing);

 const html = buildNewsletter({
 aiBriefing,
 exchangeRate: fallbackExchange,
 matchedJobs,
 totalJobs: jobs.length,
 article: defaultArticle,
 featuredTool,
 weeklyFact,
 locale: 'it',
 unsubscribeUrl: `${BASE_URL}/?action=unsubscribe&email=preview%40frontaliereticino.ch`,
 resubscribeUrl: `${BASE_URL}/?action=resubscribe&email=preview%40frontaliereticino.ch`,
 preheaderText: subject,
 });

 return { html, subject };
}
