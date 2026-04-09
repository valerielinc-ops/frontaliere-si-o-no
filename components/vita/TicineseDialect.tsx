import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation, getLocale } from '@/services/i18n';
import { Analytics } from '@/services/analytics';
import {
  Languages,
  Search,
  ChevronDown,
  ChevronUp,
  Share2,
  Check,
  Sparkles,
  Volume2,
  Lightbulb,
  GraduationCap,
  PlayCircle,
  RotateCcw,
  Send,
  Plus,
} from 'lucide-react';
import { DIALECT_ENTRIES, type DialectCategory, type DialectEntry, getDialectPhraseOfDay } from '@/services/dialectService';

type Locale = 'it' | 'en' | 'de' | 'fr';

type TermField = 'phrase' | 'italian' | 'meaning' | 'example' | 'etymology';

interface CustomTermContent {
  phrase: string;
  italian: string;
  meaning: string;
  example: string;
  etymology: string;
}

interface UserPhrase {
  id: string;
  phrase: string;
  italian: string;
  meaning: string;
  createdAt: string;
}

const USER_PHRASES_KEY = 'dialect_user_phrases_v1';

const CUSTOM_TERMS: Record<string, Record<Locale, CustomTermContent>> = {
  tacatAlTram: {
    it: {
      phrase: 'Tacàt al tram',
      italian: 'Attaccato al tram / Fai in fretta',
      meaning: 'Espressione colloquiale usata per dire a qualcuno di muoversi rapidamente o di restare al passo.',
      example: 'Dai mò, tacàt al tram che semm in ritard!',
      etymology: 'Modo di dire urbano legato al vecchio lessico dei trasporti lombardo-ticinesi.',
    },
    en: {
      phrase: 'Tacàt al tram',
      italian: 'Stick to the tram / Hurry up',
      meaning: 'Colloquial expression meaning: move quickly or keep up with the group.',
      example: 'Dai mò, tacàt al tram, we are late!',
      etymology: 'Urban idiom tied to old tramway vocabulary in the Lombard-Ticino area.',
    },
    de: {
      phrase: 'Tacàt al tram',
      italian: 'Am Tram festhalten / Beeil dich',
      meaning: 'Umgangssprachlicher Ausdruck: Beeil dich oder bleib im Tempo der Gruppe.',
      example: 'Dai mò, tacàt al tram, mir sind zu spät!',
      etymology: 'Städtische Redewendung aus dem historischen Tram-Wortschatz im lombardisch-tessiner Raum.',
    },
    fr: {
      phrase: 'Tacàt al tram',
      italian: 'Accroché au tram / Dépêche-toi',
      meaning: 'Expression familière pour dire de se dépêcher ou de rester dans le rythme.',
      example: 'Dai mò, tacàt al tram, on est en retard!',
      etymology: 'Tournure urbaine liée à l’ancien vocabulaire du tram dans l’aire lombardo-tessinoise.',
    },
  },
  sbassaLaCresta: {
    it: {
      phrase: 'Sbàssa la crèsta',
      italian: 'Abbassa la cresta',
      meaning: 'Invito a essere più umili e meno arroganti in una discussione.',
      example: 'Oh, sbàssa la crèsta e parlemm con calma.',
      etymology: 'Variante lombarda di un’espressione figurata diffusa nel Nord Italia.',
    },
    en: {
      phrase: 'Sbàssa la crèsta',
      italian: 'Lower your crest',
      meaning: 'A way to tell someone to be less arrogant and more humble.',
      example: 'Hey, sbàssa la crèsta, let’s talk calmly.',
      etymology: 'Lombard variant of a figurative expression common in Northern Italy.',
    },
    de: {
      phrase: 'Sbàssa la crèsta',
      italian: 'Nimm dich zurück',
      meaning: 'Aufforderung, weniger überheblich und bescheidener zu sein.',
      example: 'Sbàssa la crèsta und red mer ruhig.',
      etymology: 'Lombardische Variante einer bildhaften Redensart aus Norditalien.',
    },
    fr: {
      phrase: 'Sbàssa la crèsta',
      italian: 'Baisse d’un ton',
      meaning: 'Invite à être moins arrogant et plus humble.',
      example: 'Sbàssa la crèsta, parlons calmement.',
      etymology: 'Variante lombarde d’une expression figurée répandue dans le nord de l’Italie.',
    },
  },
  capiNaMazza: {
    it: {
      phrase: 'Capì na màzza',
      italian: 'Non capire nulla',
      meaning: 'Espressione informale per dire che non si è capito niente di una situazione.',
      example: 'Con quel traffich in dogana, gh’ho capì na màzza.',
      etymology: 'Costruzione colloquiale condivisa tra italiano regionale e parlata lombarda.',
    },
    en: {
      phrase: 'Capì na màzza',
      italian: 'To understand nothing',
      meaning: 'Informal way to say you did not understand anything.',
      example: 'With that border traffic, I capì na màzza.',
      etymology: 'Colloquial construction shared between regional Italian and Lombard speech.',
    },
    de: {
      phrase: 'Capì na màzza',
      italian: 'Gar nichts verstehen',
      meaning: 'Umgangssprachlich: absolut nichts verstanden haben.',
      example: 'Bei dem Grenzverkehr hab ich capì na màzza.',
      etymology: 'Umgangssprachliche Form zwischen Regionalitalienisch und Lombardisch.',
    },
    fr: {
      phrase: 'Capì na màzza',
      italian: 'Ne rien comprendre',
      meaning: 'Expression familière pour dire qu’on n’a rien compris.',
      example: 'Avec ce trafic à la douane, j’ai capì na màzza.',
      etymology: 'Forme colloquiale à la frontière entre italien régional et parler lombard.',
    },
  },
  süDaCo: {
    it: {
      phrase: 'Sü da cò',
      italian: 'Su di qui / Da queste parti',
      meaning: 'Indica il territorio locale o la zona in cui ci si trova, con senso di appartenenza.',
      example: 'Sü da cò semm abituaa al frontalierato.',
      etymology: 'Locuzione deittica tipica dell’area alpina lombarda e ticinese.',
    },
    en: {
      phrase: 'Sü da cò',
      italian: 'Up here / Around here',
      meaning: 'Refers to the local area and carries a sense of community belonging.',
      example: 'Sü da cò we are used to cross-border life.',
      etymology: 'Deictic phrase typical of Alpine Lombard and Ticinese speech.',
    },
    de: {
      phrase: 'Sü da cò',
      italian: 'Hier bei uns',
      meaning: 'Bezeichnet die lokale Gegend mit einem Gefühl der Zugehörigkeit.',
      example: 'Sü da cò sind wir ans Grenzgängerleben gewöhnt.',
      etymology: 'Deiktische Wendung aus dem alpinen lombardisch-tessinischen Sprachraum.',
    },
    fr: {
      phrase: 'Sü da cò',
      italian: 'Par ici / Chez nous',
      meaning: 'Désigne la zone locale avec une nuance d’appartenance communautaire.',
      example: 'Sü da cò, on est habitués à la vie frontalière.',
      etymology: 'Expression déictique typique de l’aire alpine lombardo-tessinoise.',
    },
  },
};

const CATEGORY_COLORS: Record<DialectCategory, { bg: string; text: string; darkBg: string; darkText: string }> = {
  saluti: { bg: 'bg-blue-100', text: 'text-blue-700', darkBg: 'dark:bg-blue-900/30', darkText: 'dark:text-blue-300' },
  espressioni: { bg: 'bg-amber-100', text: 'text-amber-700', darkBg: 'dark:bg-amber-900/30', darkText: 'dark:text-amber-300' },
  proverbi: { bg: 'bg-violet-100', text: 'text-violet-700', darkBg: 'dark:bg-violet-900/30', darkText: 'dark:text-violet-300' },
  cibo: { bg: 'bg-emerald-100', text: 'text-emerald-700', darkBg: 'dark:bg-emerald-900/30', darkText: 'dark:text-emerald-300' },
  lavoro: { bg: 'bg-teal-100', text: 'text-teal-700', darkBg: 'dark:bg-teal-900/30', darkText: 'dark:text-teal-300' },
  natura: { bg: 'bg-sky-100', text: 'text-sky-700', darkBg: 'dark:bg-sky-900/30', darkText: 'dark:text-sky-300' },
};

const CATEGORY_ICONS: Record<DialectCategory, string> = {
  saluti: '👋',
  espressioni: '💬',
  proverbi: '📜',
  cibo: '🍽️',
  lavoro: '🔧',
  natura: '🌿',
};

const TicineseDialect: React.FC = () => {
  const { t } = useTranslation();
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<DialectCategory | 'all'>('all');
  const [expandedEntry, setExpandedEntry] = useState<string | null>(null);
  const [expandCount, setExpandCount] = useState(0);
  const [copied, setCopied] = useState(false);
  const [phraseOfDayDismissed, setPhraseOfDayDismissed] = useState(false);
  const [playingKey, setPlayingKey] = useState<string | null>(null);
  const [quizState, setQuizState] = useState<{ promptKey: string; options: string[]; correct: string; selected: string | null } | null>(null);
  const [userPhrases, setUserPhrases] = useState<UserPhrase[]>([]);
  const [newPhrase, setNewPhrase] = useState({ phrase: '', italian: '', meaning: '' });
  const [savedUserPhrase, setSavedUserPhrase] = useState(false);

  const categories = useMemo<DialectCategory[]>(() => ['saluti', 'espressioni', 'proverbi', 'cibo', 'lavoro', 'natura'], []);
  const phraseOfDay = useMemo(() => getDialectPhraseOfDay(), []);
  const locale = getLocale() as Locale;
  const voiceLocale = locale === 'de' ? 'de-CH' : locale === 'fr' ? 'fr-CH' : locale === 'en' ? 'en-US' : 'it-CH';

  const tt = (key: string, fallback: string) => {
    const value = t(key);
    return value === key ? fallback : value;
  };

  const termField = (entry: DialectEntry, field: TermField): string => {
    const custom = CUSTOM_TERMS[entry.key]?.[locale] || CUSTOM_TERMS[entry.key]?.it;
    if (custom) return custom[field];
    const key = `dialect.terms.${entry.key}.${field}`;
    const value = t(key);
    return value === key ? '' : value;
  };

  useEffect(() => {
    Analytics.trackPageView('/dialetto-ticinese', 'Dialetto Ticinese');
    Analytics.trackUIInteraction('dialect', 'page', 'dialect_page', 'view');
  }, []);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(USER_PHRASES_KEY);
      if (raw) setUserPhrases(JSON.parse(raw));
    } catch {
      setUserPhrases([]);
    }
  }, []);

  const filteredEntries = useMemo(() => {
    return DIALECT_ENTRIES.filter((entry) => {
      if (selectedCategory !== 'all' && entry.category !== selectedCategory) return false;
      if (!searchTerm) return true;
      const term = searchTerm.toLowerCase();
      const phrase = termField(entry, 'phrase').toLowerCase();
      const italian = termField(entry, 'italian').toLowerCase();
      const meaning = termField(entry, 'meaning').toLowerCase();
      return phrase.includes(term) || italian.includes(term) || meaning.includes(term) || entry.key.toLowerCase().includes(term);
    });
  }, [searchTerm, selectedCategory, locale]);

  const generateQuiz = () => {
    const pool = DIALECT_ENTRIES.filter(e => termField(e, 'italian') && termField(e, 'phrase'));
    if (pool.length < 4) return;
    const prompt = pool[Math.floor(Math.random() * pool.length)];
    const wrong = pool.filter(p => p.key !== prompt.key).sort(() => Math.random() - 0.5).slice(0, 3);
    const options = [prompt, ...wrong].sort(() => Math.random() - 0.5).map(e => e.key);
    setQuizState({ promptKey: prompt.key, options, correct: prompt.key, selected: null });
    Analytics.trackUIInteraction('dialect', 'quiz', 'new_quiz', 'generate');
  };

  useEffect(() => {
    generateQuiz();
  }, [locale]);

  const handleExpand = (key: string) => {
    const wasExpanded = expandedEntry === key;
    setExpandedEntry(wasExpanded ? null : key);
    Analytics.trackUIInteraction('dialect', 'entry', key, wasExpanded ? 'collapse' : 'expand');
    if (!wasExpanded) {
      const newCount = expandCount + 1;
      setExpandCount(newCount);
      if (newCount >= 5) import('@/services/gamificationService').then(m => m.unlockAchievement('dialect_explorer'));
    }
  };

  const handleShare = async (entry: DialectEntry) => {
    const phrase = termField(entry, 'phrase');
    const italian = termField(entry, 'italian');
    const text = `🇨🇭 ${tt('dialect.title', 'Dialetto Ticinese')}: "${phrase}" — ${italian}\n\nhttps://frontaliereticino.ch/dialetto-ticinese`;
    try {
      if (navigator.share) {
        await navigator.share({ title: tt('dialect.title', 'Dialetto Ticinese'), text });
      } else if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
      Analytics.trackShare('native', 'dialect_entry', entry.key);
      Analytics.trackUIInteraction('dialect', 'entry', entry.key, 'share');
    } catch {
      // noop
    }
  };

  const pronounce = (entry: DialectEntry) => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    const phrase = termField(entry, 'phrase').replace(/["'!?.]/g, '');
    if (!phrase) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(phrase);
    u.lang = voiceLocale;
    u.rate = 0.9;
    u.onstart = () => setPlayingKey(entry.key);
    u.onend = () => setPlayingKey(null);
    u.onerror = () => setPlayingKey(null);
    window.speechSynthesis.speak(u);
    Analytics.trackUIInteraction('dialect', 'audio', entry.key, 'play');
  };

  const saveUserPhrase = () => {
    if (!newPhrase.phrase.trim() || !newPhrase.italian.trim() || !newPhrase.meaning.trim()) return;
    const record: UserPhrase = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      phrase: newPhrase.phrase.trim(),
      italian: newPhrase.italian.trim(),
      meaning: newPhrase.meaning.trim(),
      createdAt: new Date().toISOString(),
    };
    const next = [record, ...userPhrases].slice(0, 12);
    setUserPhrases(next);
    localStorage.setItem(USER_PHRASES_KEY, JSON.stringify(next));
    setNewPhrase({ phrase: '', italian: '', meaning: '' });
    setSavedUserPhrase(true);
    setTimeout(() => setSavedUserPhrase(false), 1800);
    Analytics.trackUIInteraction('dialect', 'community', 'user_phrase', 'submit');
  };

  return (
    <div className="space-y-6">
      <div className="bg-orange-600 dark:bg-orange-700 rounded-2xl p-4 sm:p-6 text-white">
        <div className="flex items-center gap-3 mb-2">
          <Languages size={28} />
          <h2 className="text-2xl font-bold">{tt('dialect.title', 'Dialetto Ticinese')}</h2>
        </div>
        <p className="text-orange-100 text-sm">{tt('dialect.subtitle', 'Scopri il dialetto del territorio di frontiera')}</p>
      </div>

      {!phraseOfDayDismissed && (
        <div className="bg-gradient-to-r from-amber-50 to-orange-50 dark:from-amber-950/30 dark:to-orange-950/30 border border-amber-200 dark:border-amber-800 rounded-xl p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <Sparkles size={20} className="text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
              <div>
                <p className="text-xs font-semibold text-amber-700 dark:text-amber-400 mb-1">{tt('dialect.phraseOfDay', 'Frase del giorno')}</p>
                <p className="text-lg font-bold text-slate-800 dark:text-slate-100 italic">"{termField(phraseOfDay, 'phrase')}"</p>
                <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">{termField(phraseOfDay, 'italian')}</p>
              </div>
            </div>
            <div className="flex items-center gap-1">
              <button onClick={() => pronounce(phraseOfDay)} className="p-2.5 rounded-lg hover:bg-amber-100 dark:hover:bg-amber-900/30" aria-label={tt('dialect.playAudio', 'Ascolta')}>
                <Volume2 size={16} className={playingKey === phraseOfDay.key ? 'text-emerald-600 animate-pulse' : 'text-amber-600 dark:text-amber-400'} />
              </button>
              <button onClick={() => handleShare(phraseOfDay)} className="p-2.5 rounded-lg hover:bg-amber-100 dark:hover:bg-amber-900/30" aria-label={tt('dialect.share', 'Condividi')}>
                {copied ? <Check size={16} className="text-emerald-600" /> : <Share2 size={16} className="text-amber-600 dark:text-amber-400" />}
              </button>
              <button onClick={() => setPhraseOfDayDismissed(true)} className="p-2.5 rounded-lg hover:bg-amber-100 dark:hover:bg-amber-900/30 text-amber-500" aria-label={tt('common.close', 'Chiudi')}>×</button>
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <Lightbulb size={18} className="text-indigo-500" />
            <h3 className="font-semibold text-slate-800 dark:text-slate-100">{tt('dialect.historyTitle', 'Storia del dialetto')}</h3>
          </div>
          <p className="text-sm text-slate-600 dark:text-slate-300">{tt('dialect.historyText', 'Il dialetto ticinese appartiene al gruppo lombardo occidentale, con influenze alpine, italiane e svizzere. Nella vita quotidiana convive con l’italiano standard, soprattutto nei contesti di lavoro frontaliero.')}</p>
        </div>

        <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <GraduationCap size={18} className="text-violet-500" />
            <h3 className="font-semibold text-slate-800 dark:text-slate-100">{tt('dialect.quizTitle', 'Quiz')}</h3>
          </div>
          {quizState && (
            <div className="space-y-2">
              <p className="text-sm text-slate-700 dark:text-slate-200">{tt('dialect.quizPrompt', 'Indovina il significato di')}: <span className="font-bold italic">"{termField({ key: quizState.promptKey, category: 'espressioni' }, 'phrase')}"</span></p>
              {quizState.options.map((opt) => {
                const isSelected = quizState.selected === opt;
                const isCorrect = quizState.selected && opt === quizState.correct;
                return (
                  <button
                    key={opt}
                    onClick={() => {
                      setQuizState(prev => prev ? { ...prev, selected: opt } : prev);
                      Analytics.trackUIInteraction('dialect', 'quiz', 'answer_select', 'select', opt);
                    }}
                    className={`w-full text-left px-2.5 py-2 rounded-lg border text-xs font-medium transition-colors
                      ${isCorrect
                        ? 'border-emerald-400 bg-emerald-50 text-emerald-800 dark:bg-emerald-900/20 dark:text-emerald-200'
                        : isSelected
                          ? 'border-red-400 bg-red-50 text-red-800 dark:bg-red-900/30 dark:text-red-200'
                          : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-100 focus:bg-slate-100 dark:border-slate-500 dark:bg-slate-800 dark:text-white dark:hover:bg-slate-700 dark:focus:bg-slate-700'}
                    `}
                  >
                    {termField({ key: opt, category: 'espressioni' }, 'italian')}
                  </button>
                );
              })}
              <div className="flex items-center justify-between pt-1">
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  {quizState.selected
                    ? quizState.selected === quizState.correct
                      ? tt('dialect.quizCorrect', 'Corretto!')
                      : `${tt('dialect.quizWrong', 'Non esatto')}: ${termField({ key: quizState.correct, category: 'espressioni' }, 'italian')}`
                    : tt('dialect.quizHint', 'Scegli una risposta')}
                </span>
                <button onClick={generateQuiz} className="inline-flex items-center gap-1 text-xs text-indigo-600 dark:text-indigo-300 hover:underline">
                  <RotateCcw size={12} /> {tt('dialect.quizNext', 'Nuova domanda')}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-3 items-center">
        <div className="relative flex-1 min-w-[220px]">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 dark:text-slate-400" />
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => {
              const value = e.target.value;
              setSearchTerm(value);
              if (value.trim().length >= 2) {
                Analytics.trackSearch(value.trim());
              }
            }}
            placeholder={tt('dialect.searchPlaceholder', 'Cerca una parola o espressione...')}
            className="w-full pl-9 pr-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-sm text-slate-800 dark:text-slate-200"
            aria-label={tt('dialect.searchPlaceholder', 'Cerca una parola o espressione...')}
          />
        </div>

        <div className="flex gap-1.5 flex-wrap">
          <button
            onClick={() => {
              setSelectedCategory('all');
              Analytics.trackUIInteraction('dialect', 'filter', 'category', 'all');
            }}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
              selectedCategory === 'all'
                ? 'bg-slate-800 dark:bg-slate-200 text-white dark:text-slate-800'
                : 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-600'
            }`}
          >
            {tt('dialect.allCategories', 'Tutte')}
          </button>
          {categories.map((cat) => {
            const colors = CATEGORY_COLORS[cat];
            return (
              <button
                key={cat}
                onClick={() => {
                  setSelectedCategory(cat);
                  Analytics.trackUIInteraction('dialect', 'filter', 'category', 'select', cat);
                }}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                  selectedCategory === cat
                    ? `${colors.bg} ${colors.text} ${colors.darkBg} ${colors.darkText}`
                    : 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-600'
                }`}
              >
                {CATEGORY_ICONS[cat]} {tt(`dialect.category.${cat}`, cat)}
              </button>
            );
          })}
        </div>
      </div>

      <p className="text-xs text-slate-500 dark:text-slate-400">{filteredEntries.length} {tt('dialect.termsFound', 'espressioni trovate')}</p>

      <div className="space-y-2">
        {filteredEntries.length === 0 ? (
          <div className="text-center py-12 text-slate-500 dark:text-slate-400">
            <Languages size={48} className="mx-auto mb-3 opacity-30" />
            <p className="font-semibold">{tt('dialect.noResults', 'Nessun risultato trovato')}</p>
          </div>
        ) : (
          filteredEntries.map((entry) => {
            const colors = CATEGORY_COLORS[entry.category];
            const isExpanded = expandedEntry === entry.key;
            const phrase = termField(entry, 'phrase');
            const italian = termField(entry, 'italian');

            return (
              <div key={entry.key} className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden">
                <button onClick={() => handleExpand(entry.key)} className="w-full flex items-center justify-between p-4 text-left" aria-expanded={isExpanded}>
                  <div className="flex items-center gap-3 min-w-0">
                    <span className={`text-xs font-bold px-2 py-0.5 rounded-full shrink-0 ${colors.bg} ${colors.text} ${colors.darkBg} ${colors.darkText}`}>
                      {CATEGORY_ICONS[entry.category]} {tt(`dialect.category.${entry.category}`, entry.category)}
                    </span>
                    <div className="min-w-0">
                      <span className="font-semibold text-sm text-slate-800 dark:text-slate-200 italic block truncate">{phrase}</span>
                      <span className="text-xs text-slate-500 dark:text-slate-400 block truncate">{italian}</span>
                    </div>
                  </div>
                  {isExpanded ? <ChevronUp size={16} className="text-slate-500 dark:text-slate-300 shrink-0" /> : <ChevronDown size={16} className="text-slate-500 dark:text-slate-300 shrink-0" />}
                </button>

                {isExpanded && (
                  <div className="px-4 pb-4 text-sm text-slate-600 dark:text-slate-400 animate-fade-in border-t border-slate-100 dark:border-slate-700 pt-3 space-y-3">
                    <p>{termField(entry, 'meaning')}</p>
                    {!!termField(entry, 'example') && (
                      <div className="bg-slate-50 dark:bg-slate-700/50 rounded-lg p-3 text-xs">
                        <span className="font-semibold text-slate-700 dark:text-slate-300">{tt('dialect.example', 'Esempio')}: </span>
                        <span className="italic">{termField(entry, 'example')}</span>
                      </div>
                    )}
                    {!!termField(entry, 'etymology') && (
                      <div className="bg-indigo-50 dark:bg-indigo-950/30 rounded-lg p-3 text-xs">
                        <span className="font-semibold text-indigo-700 dark:text-indigo-300">{tt('dialect.etymology', 'Etimologia')}: </span>
                        <span>{termField(entry, 'etymology')}</span>
                      </div>
                    )}
                    <div className="flex items-center gap-2">
                      <button onClick={() => pronounce(entry)} className="inline-flex items-center gap-1.5 text-xs text-teal-700 dark:text-teal-300 hover:underline">
                        <Volume2 size={14} className={playingKey === entry.key ? 'animate-pulse' : ''} /> {tt('dialect.playAudio', 'Ascolta')}
                      </button>
                      <button onClick={() => handleShare(entry)} className="inline-flex items-center gap-1.5 text-xs text-orange-600 dark:text-orange-400 hover:underline">
                        {copied ? <Check size={14} /> : <Share2 size={14} />} {tt('dialect.share', 'Condividi')}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 p-4">
        <div className="flex items-center gap-2 mb-3">
          <PlayCircle size={18} className="text-fuchsia-500" />
          <h3 className="font-semibold text-slate-800 dark:text-slate-100">{tt('dialect.userSectionTitle', 'Frasi proposte dagli utenti')}</h3>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-2 mb-3">
          <input
            value={newPhrase.phrase}
            onChange={(e) => setNewPhrase(prev => ({ ...prev, phrase: e.target.value }))}
            placeholder={tt('dialect.userPhrase', 'Frase in dialetto')}
            aria-label={tt('dialect.userPhrase', 'Frase in dialetto')}
            className="px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-600 bg-slate-50 dark:bg-slate-900"
          />
          <input
            value={newPhrase.italian}
            onChange={(e) => setNewPhrase(prev => ({ ...prev, italian: e.target.value }))}
            placeholder={tt('dialect.userItalian', 'Traduzione')}
            aria-label={tt('dialect.userItalian', 'Traduzione')}
            className="px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-600 bg-slate-50 dark:bg-slate-900"
          />
          <input
            value={newPhrase.meaning}
            onChange={(e) => setNewPhrase(prev => ({ ...prev, meaning: e.target.value }))}
            placeholder={tt('dialect.userMeaning', 'Significato/contesto')}
            aria-label={tt('dialect.userMeaning', 'Significato/contesto')}
            className="px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-600 bg-slate-50 dark:bg-slate-900"
          />
        </div>

        <button
          onClick={saveUserPhrase}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-fuchsia-600 hover:bg-fuchsia-700 text-white text-xs font-semibold"
        >
          {savedUserPhrase ? <Check size={14} /> : <Send size={14} />} {tt('dialect.userSubmit', 'Invia frase')}
        </button>

        {userPhrases.length > 0 && (
          <div className="mt-4 space-y-2">
            {userPhrases.map((p) => (
              <div key={p.id} className="rounded-lg border border-slate-200 dark:border-slate-700 p-2.5">
                <p className="text-sm font-semibold italic text-slate-800 dark:text-slate-100">{p.phrase}</p>
                <p className="text-xs text-slate-600 dark:text-slate-300">{p.italian}</p>
                <p className="text-xs text-slate-500 dark:text-slate-400">{p.meaning}</p>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="rounded-xl border border-emerald-200 dark:border-emerald-800 bg-emerald-50/70 dark:bg-emerald-950/30 p-4 text-xs text-emerald-800 dark:text-emerald-300">
        <div className="font-semibold flex items-center gap-2 mb-1"><Plus size={14} /> {tt('dialect.newPhrasesTitle', 'Nuove frasi aggiunte')}</div>
        <p>{tt('dialect.newPhrasesText', 'Aggiunte espressioni d’uso comune recuperate da repertori e articoli locali: “Tacàt al tram”, “Sbàssa la crèsta”, “Capì na màzza”, “Sü da cò”.')}</p>
      </div>
    </div>
  );
};

export default TicineseDialect;
