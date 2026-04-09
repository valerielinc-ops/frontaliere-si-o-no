/**
 * AiChatbot — Floating AI assistant for frontalieri questions
 *
 * Inference architecture (free-first, multi-provider fallback):
 *   1. Firebase Function `chatbotInference` (server-side, keeps key off browser)
 *      — tries gemini-2.0-flash-lite → gemini-1.5-flash-8b internally
 *   2. Browser-side direct Gemini call (fallback when Function is unreachable)
 *      — uses gemini-2.0-flash-lite (replaces deprecated gemini-2.0-flash)
 *   3. Local deterministic fallback (always available, no network required)
 *      — keyword-matched FAQ answers with internal navigation links
 */

import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { MessageCircle, X, Send, Loader2, Bot, User, Sparkles, AlertCircle, LogIn, Shield } from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import { getConfigValue } from '@/services/firebase';
import { Analytics } from '@/services/analytics';
import { reportCaughtError } from '@/services/errorReporter';
import { unlockAchievement } from '@/services/gamificationService';
import { pushRoute, buildPath } from '@/services/router';
import { cancelOneTap, eagerAuth, promptOneTap, renderGoogleButtonWithReadiness, isLinkedInSignInAvailable, signInWithLinkedIn } from '@/services/authService';
import { NAV_ACTION_ROUTES, buildSystemPrompt, type NavAction } from '@/services/internalLinks';
import { requestSlot, releaseSlot, isActive, subscribe, hasActiveSlot, POPUP_PRIORITY } from '@/services/popupQueue';
import EmailInput, { validateEmailStrict } from '@/components/shared/EmailInput';

// ─── Types ───────────────────────────────────────────────────

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

// ─── Inference config ─────────────────────────────────────────

const GAMIFICATION_TOAST_VISIBILITY_EVENT = 'gamification-toast-visibility';

// Server-side inference endpoint (Firebase Function)
const CHATBOT_FUNCTION_URL = 'https://europe-west6-frontaliere-ticino.cloudfunctions.net/chatbotInference';

// Browser-side fallback: uses non-deprecated gemini-2.0-flash-lite
const GEMINI_FALLBACK_MODEL = 'gemini-2.0-flash-lite';
const GEMINI_FALLBACK_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_FALLBACK_MODEL}:generateContent`;

// ─── Local deterministic fallback ────────────────────────────
// Keyword-matched FAQ answers with internal navigation links.
// Shown when ALL remote providers are unavailable, so users never hit a dead end.

interface LocalIntent {
  keywords: string[];
  it: string;
  en: string;
  de: string;
  fr: string;
  navAction?: NavAction;
}

const LOCAL_INTENTS: LocalIntent[] = [
  {
    keywords: ['permesso g', 'permit g', 'g-permit', 'grenzgänger', 'frontaliere'],
    it: '**Permesso G (frontaliere):** Permette di lavorare in Svizzera rientrando in Italia almeno una volta la settimana. Valido per la zona di frontiera. Per approfondire consulta la [Guida Permessi](nav:permits).',
    en: '**G Permit (frontier worker):** Allows working in Switzerland while returning to Italy at least once a week. Valid in the border zone. See the [Permits Guide](nav:permits) for details.',
    de: '**Grenzgängerbewilligung G:** Erlaubt die Arbeit in der Schweiz mit wöchentlicher Rückkehr nach Italien. Gilt in der Grenzzone. Mehr im [Bewilligungsguide](nav:permits).',
    fr: '**Permis G (frontalier):** Permet de travailler en Suisse en rentrant en Italie au moins une fois par semaine. Valable dans la zone frontalière. Voir le [Guide des permis](nav:permits).',
    navAction: 'permits',
  },
  {
    keywords: ['stipendio netto', 'salario netto', 'calcolo stipendio', 'calcolatrice', 'netto', 'salary', 'gehalt', 'salaire', 'simulat'],
    it: '**Calcola il tuo stipendio netto:** Usa il nostro simulatore gratuito per calcolare il netto svizzero con imposte alla fonte, LAMal e contributi. [Apri il calcolatore](nav:calculator)',
    en: '**Calculate your net salary:** Use our free simulator to compute your Swiss net salary including withholding tax, LAMal, and contributions. [Open calculator](nav:calculator)',
    de: '**Nettolohn berechnen:** Nutze unseren kostenlosen Simulator für Brutto-Netto mit Quellensteuer, LAMal und Beiträgen. [Rechner öffnen](nav:calculator)',
    fr: '**Calculer votre salaire net:** Utilisez notre simulateur gratuit pour calculer le net suisse avec impôt à la source, LAMal et cotisations. [Ouvrir le calculateur](nav:calculator)',
    navAction: 'calculator',
  },
  {
    keywords: ['tasse', 'imposte', 'imposta alla fonte', 'quellensteuer', 'tax', 'steuer', 'irpef', 'reddito estero', 'dichiarazione'],
    it: '**Imposte per frontalieri:** L\'imposta alla fonte è trattenuta in Svizzera. Dal 2024 i "nuovi frontalieri" pagano anche in Italia (accordo bilaterale). Per i dettagli consulta la [guida dichiarazione](nav:tax-return).',
    en: '**Taxes for frontier workers:** Withholding tax is deducted in Switzerland. Since 2024, "new frontier workers" also pay in Italy under the bilateral agreement. See the [tax return guide](nav:tax-return).',
    de: '**Steuern für Grenzgänger:** Die Quellensteuer wird in der Schweiz abgezogen. Seit 2024 zahlen „neue Grenzgänger" auch in Italien. Mehr im [Steuererklärungsguide](nav:tax-return).',
    fr: '**Impôts pour frontaliers:** L\'impôt à la source est retenu en Suisse. Depuis 2024, les \"nouveaux frontaliers\" paient aussi en Italie. Voir le [guide de déclaration](nav:tax-return).',
    navAction: 'tax-return',
  },
  {
    keywords: ['lamal', 'assicurazione malattia', 'assicurazione sanitaria', 'krankenversicherung', 'health insurance', 'assurance maladie', 'cassa malati'],
    it: '**LAMal:** Come frontaliere puoi scegliere di iscriverti al LAMal svizzero o restare nel sistema italiano. La scelta dipende da età, famiglia e reddito. Confronta le opzioni in [Confronto Salute](nav:health).',
    en: '**LAMal:** As a frontier worker you can choose Swiss LAMal or stay in the Italian system. The right choice depends on age, family situation, and income. Compare in [Health Comparison](nav:health).',
    de: '**LAMal:** Als Grenzgänger kannst du die schweizer LAMal oder das italienische System wählen. Vergleiche im [Gesundheitsvergleich](nav:health).',
    fr: '**LAMal:** En tant que frontalier, tu peux choisir la LAMal suisse ou rester dans le système italien. Compare dans [Comparaison santé](nav:health).',
    navAction: 'health',
  },
  {
    keywords: ['lavoro', 'offerte', 'annunci', 'cerco lavoro', 'jobs', 'arbeit', 'emploi', 'ticino'],
    it: '**Offerte di lavoro in Ticino:** Trova le ultime offerte per frontalieri nella nostra [bacheca lavoro](nav:jobs).',
    en: '**Jobs in Ticino:** Find the latest jobs for frontier workers in our [job board](nav:jobs).',
    de: '**Jobs im Tessin:** Aktuelle Stellen für Grenzgänger auf unserer [Jobbörse](nav:jobs).',
    fr: '**Emplois au Tessin:** Trouvez les dernières offres pour frontaliers sur notre [tableau des offres](nav:jobs).',
    navAction: 'jobs',
  },
  {
    keywords: ['cambio', 'euro', 'franco', 'chf', 'tasso di cambio', 'wechselkurs', 'exchange rate', 'cours'],
    it: '**Tasso di cambio EUR/CHF:** Consulta il [calcolatore](nav:calculator) per il tasso aggiornato e per simulare il tuo stipendio netto in euro.',
    en: '**EUR/CHF exchange rate:** Check the [calculator](nav:calculator) for the latest rate and net salary simulation in euros.',
    de: '**EUR/CHF Wechselkurs:** Nutze den [Rechner](nav:calculator) für den aktuellen Kurs und Nettolohn-Simulation in Euro.',
    fr: '**Taux EUR/CHF:** Consultez le [calculateur](nav:calculator) pour le taux actuel et simuler votre salaire net en euros.',
    navAction: 'calculator',
  },
];

/**
 * Find a local fallback answer for the last user message.
 * Returns the locale-specific text or null if no intent matches.
 */
function findLocalFallback(messages: Message[], locale: string): string | null {
  const lastUser = [...messages].reverse().find(m => m.role === 'user');
  if (!lastUser) return null;
  const q = lastUser.content.toLowerCase();
  for (const intent of LOCAL_INTENTS) {
    if (intent.keywords.some(kw => q.includes(kw))) {
      const key = (locale === 'de' || locale === 'fr') ? locale : locale === 'en' ? 'en' : 'it';
      return intent[key as 'it' | 'en' | 'de' | 'fr'];
    }
  }
  return null;
}

// ─── Inference helpers ────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isSameOriginInternalUrl(href: string): boolean {
  try {
    const url = new URL(href, window.location.origin);
    return url.origin === window.location.origin;
  } catch {
    return false;
  }
}

function navigateInternalUrl(href: string): boolean {
  try {
    const url = new URL(href, window.location.origin);
    if (url.origin !== window.location.origin) return false;
    const next = `${url.pathname}${url.search}${url.hash}`;
    const curr = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (next === curr) return true;
    history.pushState({}, '', next);
    window.dispatchEvent(new PopStateEvent('popstate'));
    return true;
  } catch {
    return false;
  }
}

/**
 * Tier 1: Call the Firebase Function (server-side, API key never in browser).
 * Throws on any error so the caller can try Tier 2.
 */
async function callChatbotFunction(messages: Message[], systemPrompt: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000); // 20s timeout
  try {
    const res = await fetch(CHATBOT_FUNCTION_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, systemPrompt }),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 429) throw Object.assign(new Error('rate_limited'), { code: '429' });
    if (!res.ok || !data.ok) throw new Error(data.error || `function_error_${res.status}`);
    if (!data.text) throw new Error('empty_function_response');
    return data.text;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Tier 2: Browser-side Gemini call (fallback when Function is unreachable).
 * Uses gemini-2.0-flash-lite (non-deprecated). Requires apiKey from Remote Config.
 */
async function callGeminiBrowserFallback(messages: Message[], apiKey: string, systemPrompt: string): Promise<string> {
  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(`${GEMINI_FALLBACK_URL}?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents,
        generationConfig: { temperature: 0.7, maxOutputTokens: 1024, topP: 0.95 },
        safetySettings: [
          { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
          { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
          { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
          { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
        ],
      }),
    });

    if (response.ok) {
      const data = await response.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error('Empty response from Gemini');
      return text;
    }

    if (response.status === 429 && attempt < 2) {
      const retryAfter = response.headers.get('retry-after');
      const delayMs = retryAfter ? Number(retryAfter) * 1000 : 900 * (attempt + 1);
      await sleep(delayMs);
      continue;
    }

    const errorText = await response.text().catch(() => '');
    if (response.status === 429) throw Object.assign(new Error('Gemini API error: 429'), { code: '429' });
    throw new Error(`Gemini API error: ${response.status} ${errorText.slice(0, 200)}`);
  }

  throw Object.assign(new Error('Gemini API error: 429 Resource exhausted'), { code: '429' });
}

// ─── Rate limiting ───────────────────────────────────────────

const RATE_LIMIT_KEY = 'chatbot_msgs';
const MAX_MESSAGES_PER_DAY = 20;

function checkRateLimit(): boolean {
  try {
    const raw = localStorage.getItem(RATE_LIMIT_KEY);
    if (!raw) return true;
    const data = JSON.parse(raw);
    const today = new Date().toISOString().split('T')[0];
    if (data.date !== today) return true;
    return (data.count || 0) < MAX_MESSAGES_PER_DAY;
  } catch { return true; }
}

function incrementRateLimit(): void {
  try {
    const today = new Date().toISOString().split('T')[0];
    const raw = localStorage.getItem(RATE_LIMIT_KEY);
    let data = raw ? JSON.parse(raw) : { date: today, count: 0 };
    if (data.date !== today) data = { date: today, count: 0 };
    data.count++;
    localStorage.setItem(RATE_LIMIT_KEY, JSON.stringify(data));
  } catch { /* ignore */ }
}

// ─── Simple Markdown renderer ────────────────────────────────

function renderMarkdown(text: string): React.ReactNode[] {
  const lines = text.split('\n');
  const result: React.ReactNode[] = [];
  let listItems: React.ReactNode[] = [];
  let listType: 'ul' | 'ol' | null = null;

  const flushList = () => {
    if (listItems.length > 0) {
      const Tag = listType === 'ol' ? 'ol' : 'ul';
      const cls = listType === 'ol' ? 'list-decimal' : 'list-disc';
      result.push(<Tag key={`list-${result.length}`} className={`${cls} pl-4 my-1 space-y-0.5`}>{listItems}</Tag>);
      listItems = [];
      listType = null;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Ordered list: "1. ", "2. " etc.
    const olMatch = line.match(/^\d+\.\s+(.*)/);
    // Unordered list: "- " or "* "
    const ulMatch = !olMatch && line.match(/^[-*]\s+(.*)/);

    if (olMatch) {
      if (listType !== 'ol') { flushList(); listType = 'ol'; }
      listItems.push(<li key={`li-${i}`}>{formatInline(olMatch[1])}</li>);
    } else if (ulMatch) {
      if (listType !== 'ul') { flushList(); listType = 'ul'; }
      listItems.push(<li key={`li-${i}`}>{formatInline(ulMatch[1])}</li>);
    } else {
      flushList();
      if (line.trim() === '') {
        result.push(<div key={`br-${i}`} className="h-2" />);
      } else {
        result.push(<p key={`p-${i}`} className="my-0.5">{formatInline(line)}</p>);
      }
    }
  }
  flushList();
  return result;
}

function formatInline(text: string): React.ReactNode {
  // Process links, bold, italic, inline code
  const parts: React.ReactNode[] = [];
  const regex = /(\[([^\]]+)\]\(([^)]+)\))|(\*\*(.+?)\*\*)|(\*(.+?)\*)|(`(.+?)`)/g;
  let lastIndex = 0;
  let match;
  let key = 0;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    if (match[2] && match[3]) {
      const label = match[2];
      const target = match[3].trim();

      // [text](nav:action)
      if (target.startsWith('nav:')) {
        const action = target.replace(/^nav:/, '') as NavAction;
        const route = NAV_ACTION_ROUTES[action];
        if (route) {
          const href = buildPath(route);
          parts.push(
            <a
              key={key++}
              href={href}
              onClick={(e) => {
                e.preventDefault();
                pushRoute(route);
                window.dispatchEvent(new PopStateEvent('popstate'));
              }}
              className="font-medium text-blue-600 dark:text-blue-400 underline underline-offset-2 decoration-blue-300 dark:decoration-blue-600 hover:decoration-blue-600 dark:hover:decoration-blue-400 transition-colors cursor-pointer"
            >
              {label}
            </a>
          );
        } else {
          parts.push(label);
        }
      } else {
        // [text](url)
        const isInternal = isSameOriginInternalUrl(target);
        parts.push(
          <a
            key={key++}
            href={target}
            onClick={(e) => {
              if (isInternal) {
                e.preventDefault();
                navigateInternalUrl(target);
              }
            }}
            target={isInternal ? undefined : '_blank'}
            rel={isInternal ? undefined : 'noopener noreferrer'}
            className="font-medium text-blue-600 dark:text-blue-400 underline underline-offset-2 decoration-blue-300 dark:decoration-blue-600 hover:decoration-blue-600 dark:hover:decoration-blue-400 transition-colors cursor-pointer"
          >
            {label}
          </a>
        );
      }
    } else if (match[5]) {
      // **bold**
      parts.push(<strong key={key++} className="font-semibold">{match[5]}</strong>);
    } else if (match[7]) {
      // *italic*
      parts.push(<em key={key++}>{match[7]}</em>);
    } else if (match[9]) {
      // `code`
      parts.push(<code key={key++} className="px-1 py-0.5 bg-slate-200 dark:bg-slate-600 rounded text-xs">{match[9]}</code>);
    }
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts.length === 1 ? parts[0] : <>{parts}</>;
}

// ─── Component ───────────────────────────────────────────────

interface AiChatbotProps {
  isLoggedIn: boolean;
  onSignIn: () => Promise<any | null> | any | null;
  onSignInFacebook: () => Promise<any | null>;
  onContinueWithEmail: (email: string) => Promise<boolean>;
  /** When true, hide the chatbot entirely on mobile devices */
  hideOnMobile?: boolean;
}

const AiChatbot: React.FC<AiChatbotProps> = ({ isLoggedIn, onSignIn, onSignInFacebook, onContinueWithEmail, hideOnMobile }) => {
  const { t, locale } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [isGamificationToastVisible, setIsGamificationToastVisible] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [authGateOpen, setAuthGateOpen] = useState(false);
  const [pendingQuestion, setPendingQuestion] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authEmail, setAuthEmail] = useState('');
  const [googleButtonReady, setGoogleButtonReady] = useState(false);
  const [linkedInAvailable, setLinkedInAvailable] = useState(false);
  const [emailAccessGranted, setEmailAccessGranted] = useState<boolean>(() => {
    try {
      return localStorage.getItem('chatbot_email_access') === 'true';
    } catch {
      return false;
    }
  });
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const googleButtonRef = useRef<HTMLDivElement>(null);
  const questionStartedRef = useRef(false);
  const sessionStartMsRef = useRef<number | null>(null);
  const sessionQuestionsRef = useRef<number>(0);
  const gateOpenedRef = useRef<boolean>(false);
  const [popupBlocked, setPopupBlocked] = useState<boolean>(() => hasActiveSlot('ai-chatbot'));
  const [queueActive, setQueueActive] = useState<boolean>(() => isActive('ai-chatbot'));
  const canChat = isLoggedIn || emailAccessGranted;
  const isMobileDevice = useMemo(
    () => /Android|iPhone|iPad|iPod|Opera Mini|IEMobile|WPDesktop/i.test(navigator.userAgent),
    []
  );

  useEffect(() => { isLinkedInSignInAvailable().then(setLinkedInAvailable).catch(() => {}); }, []);

  // Build locale-aware system prompt from i18n knowledge base
  const systemPrompt = useMemo(() => buildSystemPrompt(t, locale), [t, locale]);

  // Load API key on first open
  useEffect(() => {
    if (!isOpen || apiKey !== null) return;
    getConfigValue('GEMINI_API_KEY').then(key => {
      setApiKey(key || '');
    });
  }, [isOpen, apiKey]);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Focus input when opened
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [isOpen]);

  useEffect(() => {
    const handler = (event: Event) => {
      const custom = event as CustomEvent<{ visible?: boolean }>;
      setIsGamificationToastVisible(Boolean(custom.detail?.visible));
    };
    window.addEventListener(GAMIFICATION_TOAST_VISIBILITY_EVENT, handler as EventListener);
    return () => window.removeEventListener(GAMIFICATION_TOAST_VISIBILITY_EVENT, handler as EventListener);
  }, []);

  useEffect(() => {
    const sync = () => {
      setQueueActive(isActive('ai-chatbot'));
      setPopupBlocked(hasActiveSlot('ai-chatbot'));
    };
    sync();
    const unsub = subscribe(sync);
    return () => unsub();
  }, []);

  useEffect(() => {
    if (isOpen) {
      requestSlot('ai-chatbot', POPUP_PRIORITY.CHATBOT_PANEL);
      return;
    }
    releaseSlot('ai-chatbot');
  }, [isOpen]);

  useEffect(() => () => releaseSlot('ai-chatbot'), []);

  useEffect(() => {
    if (!isOpen || canChat || !authGateOpen) {
      setGoogleButtonReady(false);
      if (googleButtonRef.current) googleButtonRef.current.innerHTML = '';
      return;
    }
    eagerAuth();
    // On mobile, One Tap / GIS iframe can overlap and steal touches from CTA buttons.
    // Keep the explicit CTA buttons only for reliable tapping.
    let timer: ReturnType<typeof setTimeout> | null = null;
    if (!isMobileDevice) {
      promptOneTap();
      timer = setTimeout(() => {
        void renderGoogleButtonWithReadiness(googleButtonRef.current, {
          width: 280,
          text: 'continue_with',
          theme: 'outline',
          size: 'large',
          locale,
        }).then((ready) => setGoogleButtonReady(ready)).catch((error) => {
          setGoogleButtonReady(false);
          reportCaughtError(error, 'chatbot.renderGoogleButton');
        });
      }, 120);
    } else if (googleButtonRef.current) {
      googleButtonRef.current.innerHTML = '';
      setGoogleButtonReady(false);
    }
    return () => {
      if (timer) clearTimeout(timer);
      cancelOneTap();
    };
  }, [isOpen, canChat, authGateOpen, isMobileDevice, locale]);

  // If auth succeeds outside this component (e.g. popup completes async),
  // close the gate and clear stale auth errors.
  useEffect(() => {
    if (!canChat) return;
    setAuthGateOpen(false);
    setAuthError(null);
  }, [canChat]);

  const handleToggle = useCallback(() => {
    setIsOpen(prev => {
      if (!prev) {
        sessionStartMsRef.current = Date.now();
        sessionQuestionsRef.current = 0;
        gateOpenedRef.current = false;
        Analytics.trackUIInteraction('chatbot', 'widget', 'open', 'toggle');
        Analytics.trackChatbotFunnel('open_chat');
        Analytics.trackChatbotUsage('panel_open', {
          auth_state: canChat ? 'authed' : 'guest',
        });
      } else {
        const elapsedMs = sessionStartMsRef.current ? Math.max(0, Date.now() - sessionStartMsRef.current) : 0;
        Analytics.trackChatbotUsage('panel_close', {
          auth_state: canChat ? 'authed' : 'guest',
          session_seconds: Math.round(elapsedMs / 1000),
          questions_sent: sessionQuestionsRef.current,
          auth_gate_opened: gateOpenedRef.current,
        });
      }
      return !prev;
    });
  }, [canChat]);

  const sendAuthedMessage = useCallback(async (text: string) => {
    if (!text.trim() || loading) return;
    if (!checkRateLimit()) {
      setError(t('chatbot.rateLimit'));
      Analytics.trackChatbotUsage('rate_limited', {
        auth_state: canChat ? 'authed' : 'guest',
      });
      return;
    }
    sessionQuestionsRef.current += 1;
    Analytics.trackChatbotUsage('question_sent', {
      auth_state: canChat ? 'authed' : 'guest',
      question_length: text.trim().length,
      question_index: sessionQuestionsRef.current,
    });

    const userMsg: Message = { role: 'user', content: text.trim() };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setLoading(true);
    setError(null);

    try {
      incrementRateLimit();

      let reply: string | null = null;
      let remoteErr: (Error & { code?: string }) | null = null;

      // Tier 1: Firebase Function — API key stays server-side
      try {
        reply = await callChatbotFunction(newMessages, systemPrompt);
      } catch (err1) {
        const e1 = err1 as Error & { code?: string };
        remoteErr = e1;
        console.warn('[Chatbot] Tier 1 failed:', e1.message);

        // Only try Tier 2 if not rate-limited (limit is per API key, shared across tiers)
        if (e1.code !== '429' && apiKey) {
          try {
            reply = await callGeminiBrowserFallback(newMessages, apiKey, systemPrompt);
          } catch (err2) {
            const e2 = err2 as Error & { code?: string };
            remoteErr = e2;
            console.warn('[Chatbot] Tier 2 failed:', e2.message);
          }
        }
      }

      if (reply !== null) {
        setMessages(prev => [...prev, { role: 'assistant', content: reply! }]);
        Analytics.trackChatbotFunnel('response_generated');
        // Gamification: first chat interaction
        if (messages.length === 0) {
          unlockAchievement('chatbot_user');
          Analytics.trackUIInteraction('chatbot', 'conversation', 'first_message', 'sent');
        }
      } else {
        // Tier 3: Local deterministic FAQ fallback — always available, no network required
        const localReply = findLocalFallback(newMessages, locale);
        if (localReply) {
          const notice = t('chatbot.localFallbackNotice');
          setMessages(prev => [...prev, { role: 'assistant', content: `${localReply}\n\n*${notice}*` }]);
          Analytics.trackChatbotFunnel('response_generated');
          Analytics.trackChatbotUsage('inference_local_fallback', { reason: remoteErr?.code ?? 'unknown' });
        } else {
          // All tiers exhausted — show specific error
          reportCaughtError(remoteErr, 'aiChatbot.sendMessage');
          const is429 = remoteErr?.code === '429';
          setError(is429 ? t('chatbot.error429') : t('chatbot.error'));
          Analytics.trackChatbotUsage('api_error', { reason: is429 ? '429' : 'all_failed' });
        }
      }
    } catch (err) {
      console.warn('[Chatbot] Unexpected error:', err);
      reportCaughtError(err, 'aiChatbot.sendMessage');
      setError(t('chatbot.error'));
      Analytics.trackChatbotUsage('api_error', { reason: 'generic' });
    } finally {
      setLoading(false);
    }
  }, [loading, apiKey, messages, t, systemPrompt, canChat, locale]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || loading) return;
    Analytics.trackChatbotQuestion(text, {
      auth_state: canChat ? 'authed' : 'guest',
      trigger: canChat ? 'send' : 'send_attempt',
    });
    if (!canChat) {
      setPendingQuestion(text);
      setAuthGateOpen(true);
      gateOpenedRef.current = true;
      setAuthError(null);
      Analytics.trackUIInteraction('chatbot', 'auth_gate', 'open', 'send_attempt');
      Analytics.trackChatbotFunnel('gate_opened');
      Analytics.trackChatbotUsage('auth_gate_open', {
        trigger: 'send_attempt',
        has_pending_question: true,
      });
      return;
    }
    setInput('');
    await sendAuthedMessage(text);
  }, [input, loading, canChat, sendAuthedMessage]);

  useEffect(() => {
    if (!canChat || !pendingQuestion) return;
    const queued = pendingQuestion;
    setPendingQuestion('');
    setAuthGateOpen(false);
    setInput('');
    sendAuthedMessage(queued);
  }, [canChat, pendingQuestion, sendAuthedMessage]);

  const hasBottomOverlay = isGamificationToastVisible;

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend]);

  // Hide chatbot on mobile when requested (e.g., blog articles)
  if (hideOnMobile && isMobileDevice) return null;

  return (
    <>
      {/* Floating button */}
      {!isOpen && !popupBlocked && (
        <button
          onClick={handleToggle}
          className={`fixed right-4 z-[53] w-14 h-14 rounded-full bg-blue-600 hover:bg-blue-700 text-white shadow-lg hover:shadow-xl transition-[color,background-color,border-color,box-shadow,transform] flex items-center justify-center group ${hasBottomOverlay ? 'bottom-44 md:bottom-6' : 'bottom-24 md:bottom-6'}`}
          aria-label={t('chatbot.openLabel')}
        >
          <MessageCircle size={24} className="group-hover:scale-110 transition-transform" />
          <span className="absolute -top-1 -right-1 w-3 h-3 bg-emerald-400 rounded-full" />
        </button>
      )}

      {/* Chat panel */}
      {isOpen && queueActive && (
        <div className={`fixed right-4 z-[53] w-[360px] max-w-[calc(100vw-2rem)] h-[500px] max-h-[calc(100vh-6rem)] bg-white dark:bg-slate-800 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700 flex flex-col overflow-hidden animate-fade-in ${hasBottomOverlay ? 'bottom-48 md:bottom-4' : 'bottom-24 md:bottom-4'}`}>
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 bg-blue-600 text-white rounded-t-2xl shrink-0">
            <div className="flex items-center gap-2">
              <Sparkles size={18} />
              <span className="font-semibold text-sm">{t('chatbot.title')}</span>
            </div>
            <button
              onClick={handleToggle}
              className="p-1 hover:bg-blue-500 rounded-lg transition-colors"
              aria-label={t('chatbot.closeLabel')}
            >
              <X size={18} />
            </button>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
            {!canChat ? (
              <div className="flex flex-col items-center justify-center h-full text-center px-4">
                <div className="w-16 h-16 rounded-full bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center mb-4">
                  <Bot size={32} className="text-blue-600 dark:text-blue-300" />
                </div>
                <h3 className="text-base font-semibold text-slate-800 dark:text-white mb-2">{t('chatbot.title')}</h3>
                <p className="text-sm text-slate-600 dark:text-slate-400 mb-3 leading-relaxed">{t('chatbot.authRequiredToSend')}</p>
                <p className="text-xs text-slate-500 dark:text-slate-400">{t('chatbot.preAuthHint')}</p>
                <div className="mt-4 w-full max-w-xs space-y-2">
                  {[
                    t('chatbot.suggestion1'),
                    t('chatbot.suggestion2'),
                    t('chatbot.suggestion3'),
                  ].map((suggestion, i) => (
                    <button
                      key={i}
                      onClick={() => {
                        Analytics.trackChatbotQuestion(suggestion, {
                          auth_state: 'guest',
                          trigger: 'quick_question',
                        });
                        setPendingQuestion(suggestion);
                        setInput(suggestion);
                        setAuthGateOpen(true);
                        gateOpenedRef.current = true;
                        setAuthError(null);
                        Analytics.trackUIInteraction('chatbot', 'auth_gate', 'open', 'quick_question');
                        Analytics.trackChatbotUsage('auth_gate_open', {
                          trigger: 'quick_question',
                          has_pending_question: true,
                        });
                      }}
                      className="block w-full text-left text-xs px-3 py-2 rounded-lg bg-slate-50 dark:bg-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-600 transition-colors"
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
            <>
            {messages.length === 0 && (
              <div className="text-center py-8">
                <Bot size={40} className="mx-auto text-slate-300 dark:text-slate-600 mb-3" />
                <p className="text-sm text-slate-500 dark:text-slate-400">{t('chatbot.welcome')}</p>
                <div className="mt-4 space-y-2">
                  {[
                    t('chatbot.suggestion1'),
                    t('chatbot.suggestion2'),
                    t('chatbot.suggestion3'),
                  ].map((suggestion, i) => (
                    <button
                      key={i}
                      onClick={() => { setInput(suggestion); }}
                      className="block w-full text-left text-xs px-3 py-2 rounded-lg bg-slate-50 dark:bg-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-600 transition-colors"
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>
              </div>
            )}
            
            {messages.map((msg, i) => (
              <div
                key={i}
                className={`flex gap-2 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                {msg.role === 'assistant' && (
                  <div className="w-7 h-7 rounded-full bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center shrink-0">
                    <Bot size={14} className="text-blue-600 dark:text-blue-300" />
                  </div>
                )}
                <div
                  className={`max-w-[80%] px-3 py-2 rounded-2xl text-sm ${
                    msg.role === 'user'
                      ? 'bg-blue-600 text-white rounded-br-md whitespace-pre-wrap'
                      : 'bg-slate-100 dark:bg-slate-700 text-slate-900 dark:text-white rounded-bl-md'
                  }`}
                >
                  {msg.role === 'assistant' ? renderMarkdown(msg.content) : msg.content}
                </div>
                {msg.role === 'user' && (
                  <div className="w-7 h-7 rounded-full bg-slate-200 dark:bg-slate-600 flex items-center justify-center shrink-0">
                    <User size={14} className="text-slate-600 dark:text-slate-300" />
                  </div>
                )}
              </div>
            ))}
            
            {loading && (
              <div className="flex gap-2 justify-start">
                <div className="w-7 h-7 rounded-full bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center shrink-0">
                  <Bot size={14} className="text-blue-600 dark:text-blue-300" />
                </div>
                <div className="bg-slate-100 dark:bg-slate-700 rounded-2xl rounded-bl-md px-4 py-3">
                  <Loader2 size={16} className="animate-spin text-blue-500" />
                </div>
              </div>
            )}

            {error && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800">
                <AlertCircle size={14} className="text-red-500 shrink-0" />
                <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
              </div>
            )}
            
            <div ref={messagesEndRef} />
            </>
            )}
          </div>

          {/* Input */}
          <div className="px-3 py-3 border-t border-slate-200 dark:border-slate-700 shrink-0">
            <div className="flex gap-2">
              <input
                ref={inputRef}
                type="text"
                value={input}
                onChange={(e) => {
                  const value = e.target.value;
                  setInput(value);
                  if (!questionStartedRef.current && value.trim().length > 0) {
                    questionStartedRef.current = true;
                    Analytics.trackChatbotFunnel('question_started');
                  }
                  if (value.trim().length === 0) {
                    questionStartedRef.current = false;
                  }
                }}
                onKeyDown={handleKeyDown}
                placeholder={t('chatbot.placeholder')}
                className="flex-1 px-3 py-2 rounded-xl border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-base md:text-sm text-slate-900 dark:text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-300 dark:focus:ring-blue-700"
                style={{ fontSize: '16px' }}
                disabled={loading}
                aria-label={t('chatbot.inputLabel')}
              />
              <button
                onClick={handleSend}
                disabled={loading || !input.trim()}
                className="p-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 dark:disabled:bg-slate-600 text-white transition-colors focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
                aria-label={t('chatbot.sendLabel')}
              >
                <Send size={16} />
              </button>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1.5 text-center">
              {t('chatbot.disclaimer')}
            </p>
          </div>

          {/* Soft-auth gate: appears only when user tries to send while logged out */}
          {authGateOpen && !canChat && (
            <div className="absolute left-0 right-0 top-[56px] bottom-0 z-20 bg-white/95 dark:bg-slate-900/95 p-4 overflow-y-auto">
              <div className="max-w-sm mx-auto">
                <div className="flex justify-end mb-1">
                  <button
                    type="button"
                    onClick={handleToggle}
                    className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-200 dark:hover:bg-slate-700 hover:text-slate-700 dark:hover:text-slate-200 transition-colors"
                    aria-label={t('chatbot.closeLabel')}
                  >
                    <X size={16} />
                  </button>
                </div>
                <img src="/icons/icon-192x192.png" alt="Frontaliere Ticino" width={40} height={40} className="rounded-full mb-3 mx-auto" loading="lazy" />
                <h3 className="text-base font-semibold text-slate-900 dark:text-white text-center">{t('chatbot.authTitle')}</h3>
                <p className="text-xs font-medium text-blue-600 dark:text-blue-400 text-center">frontaliereticino.ch</p>
                <p className="text-xs text-slate-600 dark:text-slate-400 text-center mt-1 mb-3">{t('chatbot.authSubtitle')}</p>

                <div className="text-xs text-blue-700 dark:text-blue-300 bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 rounded-lg p-2 mb-3">
                  <span className="font-semibold">{t('chatbot.authContinueQuestion')}:</span> {pendingQuestion}
                </div>

                <div ref={googleButtonRef} className="mb-2 flex justify-center min-h-[1px]" />

                {!googleButtonReady && (
                  <button
                    type="button"
                    onClick={async () => {
                      setAuthError(null);
                      setAuthBusy(true);
                      Analytics.trackChatbotFunnel('method_selected', 'google');
                      try {
                        const user = await onSignIn();
                        if (user) {
                          Analytics.trackChatbotFunnel('auth_success', 'google');
                        } else {
                          setAuthError(t('chatbot.authFailed'));
                          Analytics.trackChatbotFunnel('auth_success', 'google', 'error');
                        }
                      } catch {
                        setAuthError(t('chatbot.authFailed'));
                        Analytics.trackChatbotFunnel('auth_success', 'google', 'error');
                      } finally {
                        setAuthBusy(false);
                      }
                    }}
                    disabled={authBusy}
                    className="relative z-30 touch-manipulation w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 mb-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-medium text-sm transition-colors shadow-md disabled:opacity-50"
                  >
                    <LogIn size={15} />
                    {t('chatbot.loginCta')}
                  </button>
                )}

                <p className="flex items-center justify-center gap-1.5 text-xs text-slate-500 dark:text-slate-400 mb-1">
                  <Shield size={11} className="text-emerald-600 dark:text-emerald-400 flex-shrink-0" />
                  {t('jobBoard.gate.googleRedirectNote')}
                </p>

                {/* LinkedIn Sign-In Button (conditional on Remote Config) */}
                {linkedInAvailable && (
                  <button
                    type="button"
                    onClick={() => signInWithLinkedIn()}
                    className="w-full inline-flex items-center justify-center gap-2 px-5 py-2.5 mb-2 rounded-lg bg-[#0A66C2] hover:bg-[#004182] text-white text-sm font-semibold transition-colors"
                  >
                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.064 2.064 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>
                    {locale === 'it' ? 'Continua con LinkedIn' : locale === 'de' ? 'Mit LinkedIn fortfahren' : locale === 'fr' ? 'Continuer avec LinkedIn' : 'Continue with LinkedIn'}
                  </button>
                )}

                {/* Facebook login button hidden — Facebook app not yet approved */}
                {/* TODO: Re-enable once Facebook app review is complete */}

                <div className="relative my-3">
                  <div className="absolute inset-0 flex items-center"><div className="w-full border-t border-slate-200 dark:border-slate-700" /></div>
                  <div className="relative flex justify-center text-xs"><span className="bg-white dark:bg-slate-900 px-2 text-slate-500 dark:text-slate-400">{t('chatbot.orEmail')}</span></div>
                </div>

                <div className="space-y-2">
                  <EmailInput
                    value={authEmail}
                    onChange={setAuthEmail}
                    placeholder={t('chatbot.emailPlaceholder')}
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-sm text-slate-900 dark:text-white"
                  />

                  {authError && (
                    <div className="text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg px-2 py-1.5">
                      {authError}
                    </div>
                  )}

                  <button
                    type="button"
                    disabled={authBusy}
                    onClick={async () => {
                      setAuthError(null);
                      const email = authEmail.trim().toLowerCase();
                      if (!email || !validateEmailStrict(email).valid) {
                        setAuthError(t('newsletter.invalidEmail'));
                        return;
                      }
                      setAuthBusy(true);
                      Analytics.trackChatbotFunnel('method_selected', 'email');
                      try {
                        const ok = await onContinueWithEmail(email);
                        if (ok) {
                          try { localStorage.setItem('chatbot_email_access', 'true'); } catch {}
                          setEmailAccessGranted(true);
                          Analytics.trackChatbotFunnel('auth_success', 'email');
                        } else {
                          setAuthError(t('chatbot.authFailed'));
                          Analytics.trackChatbotFunnel('auth_success', 'email', 'error');
                        }
                      } finally {
                        setAuthBusy(false);
                      }
                    }}
                    className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-medium text-sm transition-colors shadow-md disabled:opacity-50"
                  >
                    {authBusy ? <Loader2 size={15} className="animate-spin" /> : <LogIn size={15} />}
                    {t('newsletter.subscribeFree')}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
};

export default React.memo(AiChatbot);
