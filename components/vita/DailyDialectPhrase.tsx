import React, { useMemo } from 'react';
import { Sparkles, BookOpen } from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import { getDialectPhraseOfDay } from '@/services/dialectService';
import { buildPath } from '@/services/router';
import { useNavigationOptional } from '@/services/NavigationContext';

const DailyDialectPhrase: React.FC = () => {
  const { t } = useTranslation();
  const nav = useNavigationOptional();
  const phraseOfDay = useMemo(() => getDialectPhraseOfDay(), []);

  const phraseKey = `dialect.terms.${phraseOfDay.key}.phrase`;
  const dialectHref = buildPath({ activeTab: 'dialetto' });

  const phrase = t(phraseKey);

  if (phrase === phraseKey) return <div className="min-h-[34px]" />;

  return (
    <a
      href={dialectHref}
      onClick={(e) => {
        if (nav) {
          e.preventDefault();
          nav.navigateTo('dialetto');
        }
      }}
      className="flex items-center gap-2 min-h-[34px] bg-orange-50 dark:bg-orange-900/20 rounded-xl border border-orange-200/60 dark:border-orange-800/30 px-3 text-xs hover:border-orange-300/80 dark:hover:border-orange-700/50 transition-colors"
      aria-label={t('dialect.openPage')}
    >
      <Sparkles size={13} className="text-orange-500 dark:text-orange-400 flex-shrink-0" />
      <span className="font-bold text-orange-700 dark:text-orange-400 flex-shrink-0">{t('dialect.phraseOfDay')}:</span>
      <p className="flex-1 min-w-0 truncate font-bold italic text-slate-800 dark:text-slate-100">"{phrase}"</p>
      <span className="inline-flex items-center gap-1 text-slate-700 dark:text-slate-200 shrink-0">
        <BookOpen size={12} />
        <span>{t('dialect.openPage')}</span>
      </span>
    </a>
  );
};

export default DailyDialectPhrase;
