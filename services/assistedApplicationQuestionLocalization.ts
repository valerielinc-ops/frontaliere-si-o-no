type SupportedLocale = 'it' | 'de' | 'fr' | 'en';

const QUESTION_LOCALIZATION_WARNING: Record<SupportedLocale, {
  message: string;
  originalTextLabel: string;
  unknownSource: string;
}> = {
  it: {
    message: 'Non siamo riusciti a tradurre completamente la domanda e le opzioni. Il testo originale del portale ({language}) è riportato sotto; alcune opzioni possono restare nella lingua originale. Rispondi solo se comprendi domanda e opzioni.',
    originalTextLabel: 'Testo originale del portale',
    unknownSource: 'lingua non verificata',
  },
  de: {
    message: 'Frage und Optionen konnten nicht vollständig übersetzt werden. Der Originaltext des Portals ({language}) steht unten; einige Optionen können in der Originalsprache bleiben. Antworte nur, wenn du Frage und Optionen verstehst.',
    originalTextLabel: 'Originaltext des Portals',
    unknownSource: 'Sprache nicht verifiziert',
  },
  fr: {
    message: 'Impossible de traduire entièrement cette question et ses options. Le texte original du portail ({language}) apparaît ci-dessous ; certaines options peuvent rester dans la langue d’origine. Répondez seulement si vous comprenez la question et les options.',
    originalTextLabel: 'Texte original du portail',
    unknownSource: 'langue non vérifiée',
  },
  en: {
    message: "We couldn't fully translate this question and its options. The portal's original text ({language}) is shown below; some options may remain in the original language. Answer only if you understand the question and options.",
    originalTextLabel: 'Portal original text',
    unknownSource: 'language not verified',
  },
};

/** Warning copy follows the candidate's selected communication language, not the browser locale. */
export function localizedQuestionWarning(candidateLocale: string, sourceLocale?: string | null) {
  const language = String(candidateLocale || '').trim().toLowerCase().split(/[-_]/)[0];
  const copy = Object.hasOwn(QUESTION_LOCALIZATION_WARNING, language)
    ? QUESTION_LOCALIZATION_WARNING[language as SupportedLocale]
    : QUESTION_LOCALIZATION_WARNING.it;
  const source = String(sourceLocale || '').trim();
  return {
    message: copy.message.replace('{language}', source && source.toLowerCase() !== 'unknown' ? source.toUpperCase() : copy.unknownSource),
    originalTextLabel: copy.originalTextLabel,
  };
}
