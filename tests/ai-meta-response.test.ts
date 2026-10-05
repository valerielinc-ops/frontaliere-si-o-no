import { describe, it, expect, vi, beforeEach } from 'vitest';
import { detectAiMetaResponse } from '@/scripts/lib/ai-meta-response.mjs';
import { isAcceptableTranslation, isModelMetaAnswer } from '@/scripts/lib/translation-quality.mjs';
import { isIncomplete } from '@/scripts/lib/translation-incomplete.mjs';
import {
  aiTranslateJobTitleDCC,
  isLowQualityLocalizedTitle,
} from '@/scripts/lib/dedicated-crawler-common.mjs';
import { freeTranslateWithRetry } from '@/scripts/lib/free-translate.mjs';
import {
  sanitizeAssembledLocaleMap,
  sanitizeAssembledLocaleValue,
} from '@/scripts/relocalize-pending-jobs.mjs';

vi.mock('@/scripts/lib/free-translate.mjs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/scripts/lib/free-translate.mjs')>();
  return { ...actual, freeTranslateWithRetry: vi.fn() };
});

/**
 * Scheda AI-REFUSAL (trovata da PR 11540): un campo tradotto conteneva la
 * RISPOSTA di un modello invece della traduzione — `titleByLocale.en` di un
 * annuncio interdiscount = «I need to see the actual job title…». Non vuota,
 * diversa dalla sorgente, in una lingua plausibile: nessun controllo la
 * scartava all'accettazione e `isIncomplete()` la dava per completa, quindi
 * translate-pending toglieva il flag senza riparare e /en/ la pubblicava.
 *
 * Misura su origin/main del 2026-10-05 (slot pubblicati, annunci vivi): 58
 * titoli (it 20, en 17, fr 20, de 1) e 40 descrizioni (it), in 78 annunci.
 * Le stringhe qui sotto sono quei casi, verbatim (titoli di lavoro e testo di
 * modello: nessun dato personale).
 *
 * Il file pinna i due versi: i casi reali vengono riconosciuti in ogni punto
 * (rilevatore, accettazione della cascata e dei writer dei titoli, selettore di
 * riparazione) e i testi LEGITTIMI che ne condividono le parole («need»,
 * «sorry», «translation», «Non vedo l'ora», «As an AI …») restano intatti.
 */

const REAL_META_TITLES = [
  // refusal
  "Sorry, I can't help with that.",
  // clarification: the model asks for the input it was given
  'I need to see the actual job title you want translated. Could you provide the German job title that currently shows as "de" instead of "en"?',
  "I need to see the actual job title you're referring to. Could you provide the German job title that needs translation to French?",
  "I don't see a job title in your message to translate. Could you provide the German job title you'd like me to translate to English?",
  'I need to check the existing translations in the repository to understand the pattern and provide an accurate French translation.',
  'I need to see the job data to provide an accurate translation. Let me check the jobs files in the repository. Vendeur/vendeuse spécialisé(e)',
  // agent narration
  "I'll translate this German job title to Italian. Addetto/a alla vendita al dettaglio CFP \"Creazione di esperienze di acquisto",
  "I'll check the job data to see what the current title is and provide a fully translated English version. Let me look at the repository structure.",
  'The translated job title is: "Montchoisi-MotionLab" in English.',
  'We need to translate "GL & VAT Accountant" to English. The target language is English (en).',
  'The user wants me to translate the job title "Buyer" to English.',
  // template label left without its value / as a prefix
  'Traduzione:',
  'Traduzione: (m/f/d)',
  'Trattamento della linea Stv. Traduzione:',
  'Translated title: Vendeuse/Vendeur CFC "Créer des expériences d\'achat',
  // our own prompt's field hint copied into the answer
  'BarmanCity name (optional, probably does not need a translation)',
];

// Tool-use markup of an agentic transport: never part of a job ad.
const REAL_AGENT_DUMP = 'I need to check the current job titles in the repository to see what needs translating. '
  + '<function_calls> <invoke name="bash"> <parameter name="command">find /home/runner/work/frontaliere-articles/frontaliere-articles/data';

const LEGIT_TITLES = [
  'Stage di traduzione in francese e gestione degli ordini',
  'Translation Trainee (University or University of Applied Sciences) (m/w/x) – 100%',
  '2026 Internship – German language expert / translation specialist – ZH',
  'Policy Manager: Translating Research into Practice',
  'Pflegefachperson HF 80-100% – we need you!',
  'Barista (m/w/d) im Sorry Not Sorry Café Zürich',
  'Detailhandelsfachfrau/-mann EFZ Unterhaltungselektronik',
  'GL & VAT Accountant',
  'Übersetzer/in Deutsch–Italienisch 60%',
];

const LEGIT_DESCRIPTION_OPENERS = [
  "Non vedo l'ora. • Settimana di 39 ore con pause flessibili • Equo salario minimo da CHF 4'400",
  'As an AI Enablement Engineer, you will be responsible for accelerating AI adoption across the Technology department.',
  'Can you provide comprehensive and concise investment recommendations in a clear and timely manner?',
  "Pouvez-vous fournir des recommandations d'investissement complètes et concises de façon claire et en temps opportun?",
  'We need a motivated team player who enjoys working with customers. Sorry, no agencies.',
  // Review di #11578: una riga d'annuncio che chiede «il titolo» non e' una
  // richiesta del modello finche' non parla di tradurlo.
  'Please provide the actual job title you are applying for.',
  'Can you provide the text of your cover letter in German or Italian?',
  // Review della PR corpus 2166: «we need to …» apre annunci e articoli veri.
  'We need to produce high-quality components for the automotive industry.',
  'We need to translate our software into German and French.',
  'We need to keep our customers at the centre of everything we do.',
];

const DE_DESC = 'Als Detailhandelsfachfrau oder Detailhandelsfachmann beraten Sie unsere Kundinnen und Kunden kompetent und freundlich. '
  + 'Sie präsentieren die neuesten Produkte im Laden, bewirtschaften das Sortiment und sorgen für ein sauberes und einladendes Einkaufserlebnis in der Filiale.';
const IT_DESC = 'In qualità di impiegata o impiegato del commercio al dettaglio consigli i nostri clienti con competenza e cordialità. '
  + "Presenti i prodotti più recenti nel negozio, gestisci l'assortimento e garantisci un'esperienza di acquisto pulita e accogliente nella filiale.";

function completeJob() {
  return {
    title: 'Detailhandelsfachfrau/-mann EFZ Unterhaltungselektronik',
    sourceLang: 'de',
    description: DE_DESC,
    titleByLocale: {
      de: 'Detailhandelsfachfrau/-mann EFZ Unterhaltungselektronik',
      it: 'Impiegata/o del commercio al dettaglio AFC elettronica di consumo',
      en: 'Retail specialist (Federal VET Diploma) consumer electronics',
      fr: 'Gestionnaire du commerce de détail CFC électronique de divertissement',
    },
    descriptionByLocale: {
      de: DE_DESC,
      it: IT_DESC,
      en: 'As a retail specialist you advise our customers competently and in a friendly way. You present the latest products in the shop, '
        + 'manage the product range and make sure the shopping experience in the branch is clean and welcoming for everyone.',
      fr: 'En tant que gestionnaire du commerce de détail, vous conseillez nos clientes et clients avec compétence et amabilité. '
        + "Vous présentez les derniers produits dans le magasin, gérez l'assortiment et veillez à une expérience d'achat propre et accueillante dans la succursale.",
    },
  };
}

describe('detectAiMetaResponse — casi reali pubblicati', () => {
  it.each(REAL_META_TITLES)('riconosce %s', (title) => {
    expect(detectAiMetaResponse(title)).not.toBeNull();
  });

  it.each([
    "Sorry — I can't help with that.", "Sorry – I can't help with that.", "Sorry: I can't help with that.",
    "Sorry; I can't help with that.", "I'm sorry - I cannot translate this.", 'Désolé — je ne peux pas traduire ce texte.',
  ])('riconosce il rifiuto con qualunque separatore: %s', (refusal) => {
    expect(detectAiMetaResponse(refusal)?.kind).toBe('refusal');
  });

  it('riconosce il dump di tool-use di un agente', () => {
    expect(detectAiMetaResponse(REAL_AGENT_DUMP)).not.toBeNull();
  });

  it('riconosce la descrizione che si chiude con l\'etichetta del template', () => {
    expect(detectAiMetaResponse(`${IT_DESC}\n\nTraduzione:`)).toMatchObject({ kind: 'label-leak' });
  });

  it('riconosce la descrizione aperta dall\'etichetta del template', () => {
    expect(detectAiMetaResponse(`Traduzione: ${IT_DESC}`)).toMatchObject({ kind: 'label-leak' });
  });
});

describe('detectAiMetaResponse — testi legittimi che condividono le parole', () => {
  it.each(LEGIT_TITLES)('lascia passare il titolo %s', (title) => {
    expect(detectAiMetaResponse(title)).toBeNull();
    expect(isModelMetaAnswer(title)).toBe(false);
    expect(isLowQualityLocalizedTitle(title)).toBe(false);
  });

  it.each(LEGIT_DESCRIPTION_OPENERS)('lascia passare l\'apertura di annuncio %s', (text) => {
    expect(detectAiMetaResponse(text)).toBeNull();
  });

  it('una riga d\'annuncio che chiede il titolo non e\' una meta-risposta (sorgente italiana)', () => {
    expect(detectAiMetaResponse('Please provide the actual job title you are applying for.', {
      source: 'Indicare il titolo della posizione a cui ti candidi.',
    })).toBeNull();
    expect(detectAiMetaResponse('I need to see the actual job title you want translated.')?.kind).toBe('clarification');
  });

  it('una citazione nella sorgente non esenta una traduzione che APRE con il rifiuto', () => {
    // Review della PR corpus 2166: l'esenzione valeva per un `includes()` su
    // tutta la sorgente, quindi bastava che la sorgente citasse il rifiuto.
    const source = "Il chatbot risponde «Sorry, I can't help with that.» alle domande fuori tema.";
    expect(detectAiMetaResponse("Sorry, I can't help with that.", { source })?.kind).toBe('refusal');
    // Ma una sorgente che si apre con lo stesso marcatore resta esente.
    expect(detectAiMetaResponse("Sorry, I can't help with that.", { source: "Sorry, I can't help with that." })).toBeNull();
  });

  it('non conta un marcatore che la sorgente stessa contiene', () => {
    const source = 'Translation: German > Italian, 80% (m/w/d)';
    expect(detectAiMetaResponse(source)).not.toBeNull();
    expect(detectAiMetaResponse(source, { source })).toBeNull();
  });
});

describe('accettazione — una meta-risposta non e\' una traduzione', () => {
  it('isAcceptableTranslation scarta una descrizione con l\'etichetta rimasta', () => {
    expect(isAcceptableTranslation(DE_DESC, IT_DESC)).toBe(true);
    expect(isAcceptableTranslation(DE_DESC, `${IT_DESC}\n\nTraduzione:`)).toBe(false);
  });

  it.each(REAL_META_TITLES)('isLowQualityLocalizedTitle scarta %s', (title) => {
    expect(isLowQualityLocalizedTitle(title)).toBe(true);
  });
});

describe('isIncomplete — una meta-risposta pubblicata torna in coda', () => {
  it('un annuncio completo resta completo (controllo del verso inverso)', () => {
    expect(isIncomplete(completeJob())).toBe(false);
  });

  it('riaccoda il titolo en «I need to see the actual job title…» (caso interdiscount)', () => {
    const job = completeJob();
    job.titleByLocale.en = REAL_META_TITLES[1];
    expect(isIncomplete(job)).toBe(true);
  });

  it('riaccoda il titolo fr «Sorry, I can\'t help with that.»', () => {
    const job = completeJob();
    job.titleByLocale.fr = REAL_META_TITLES[0];
    expect(isIncomplete(job)).toBe(true);
  });

  it('riaccoda la descrizione it chiusa da «Traduzione:»', () => {
    const job = completeJob();
    job.descriptionByLocale.it = `${IT_DESC}\n\nTraduzione:`;
    expect(isIncomplete(job)).toBe(true);
  });

  it('riaccoda il titolo con il ragionamento <think> (prima controllato solo sulle descrizioni)', () => {
    const job = completeJob();
    job.titleByLocale.en = '<think> Okay, let\'s tackle this translation. The job title is "GL Accountant".';
    expect(isIncomplete(job)).toBe(true);
  });
});

describe('sync di relocalize — un valore assemblato che e\' una meta-risposta non viene scritto', () => {
  const crawlerJob = { title: 'Operaio specializzato', description: IT_DESC };
  const meta = 'I need to see the actual job title you want translated';

  it('un titolo-meta diventa il titolo canonico del crawler, mai la meta-risposta', () => {
    expect(sanitizeAssembledLocaleValue('titleByLocale', meta, crawlerJob)).toBe('Operaio specializzato');
  });

  it('sanitizza prima di adottare una mappa locale mancante', () => {
    const persisted = sanitizeAssembledLocaleMap(
      'titleByLocale',
      { en: meta },
      { ...crawlerJob, titleByLocale: undefined },
    );

    expect(persisted).toEqual({ en: 'Operaio specializzato' });
    expect(persisted.en).not.toBe(meta);
  });

  it('una descrizione-meta non viene scritta', () => {
    expect(sanitizeAssembledLocaleValue('descriptionByLocale', `${IT_DESC}\n\nTraduzione:`, crawlerJob)).toBe('');
  });

  it('un valore buono passa intatto', () => {
    expect(sanitizeAssembledLocaleValue('titleByLocale', 'Skilled worker', crawlerJob)).toBe('Skilled worker');
    expect(sanitizeAssembledLocaleValue('descriptionByLocale', IT_DESC, crawlerJob)).toBe(IT_DESC);
  });
});

describe('aiTranslateJobTitleDCC — il writer dei titoli non accetta ne\' ripete una meta-risposta', () => {
  const sourceTitle = 'Detailhandelsfachfrau/-mann EFZ Unterhaltungselektronik';
  const goodEn = 'Retail specialist (Federal VET Diploma) consumer electronics';

  // `storedMeta`: what the persistent AI cache returns for a title key never
  // written in this test — the stored meta-answers this fix must bust.
  function makeCtx(callLLM = vi.fn(), storedMeta?: string) {
    const cache = new Map<string, unknown>();
    return {
      cache,
      ctx: {
        buildAiCacheKey: (ns: string, parts: string[]) => `${ns}:${parts.join('|')}`,
        getCachedAiResponse: (k: string) => (cache.has(k) || !storedMeta || !k.startsWith('translate-title-v2:')
          ? cache.get(k)
          : storedMeta),
        setCachedAiResponse: (k: string, v: unknown) => { cache.set(k, v); },
        AI_CACHE_RAW_SENTINEL: '__RAW__',
        callLLM,
        isAnyModelAvailable: () => true,
        isLowQualityLocalizedTitle,
      },
    };
  }

  beforeEach(() => {
    vi.mocked(freeTranslateWithRetry).mockReset();
  });

  it('una meta-risposta in cache e\' un MISS: si ritraduce e la voce viene sovrascritta', async () => {
    const { cache, ctx } = makeCtx(vi.fn(), REAL_META_TITLES[1]);
    vi.mocked(freeTranslateWithRetry).mockResolvedValue(goodEn);

    const out = await aiTranslateJobTitleDCC({ title: sourceTitle, locale: 'en', sourceLang: 'de' }, ctx);

    expect(out).toBe(goodEn);
    expect([...cache.values()]).toContain(goodEn);
  });

  it('il rifiuto del modello non viene accettato ne\' salvato in cache', async () => {
    const callLLM = vi.fn().mockResolvedValue("Sorry, I can't help with that.");
    const { cache, ctx } = makeCtx(callLLM);
    // La cascata gratuita rende la sorgente (passthrough): si scende all'LLM.
    vi.mocked(freeTranslateWithRetry).mockResolvedValue(sourceTitle);

    const out = await aiTranslateJobTitleDCC({ title: sourceTitle, locale: 'en', sourceLang: 'de' }, ctx);

    expect(callLLM).toHaveBeenCalled();
    expect(isModelMetaAnswer(out)).toBe(false);
    for (const value of cache.values()) expect(isModelMetaAnswer(String(value))).toBe(false);
  });
});
