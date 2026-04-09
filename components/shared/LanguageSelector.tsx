import React, { useState, useRef, useEffect } from 'react';
import { type Locale, getLocale, setLocale, onLocaleChange, LOCALE_LABELS } from '@/services/i18n';
import { ensureJobSlugMapLoaded, updatePathForLocale } from '@/services/router';
import { Analytics } from '@/services/analytics';

const LanguageSelector: React.FC = () => {
  const [isOpen, setIsOpen] = useState(false);
  const [current, setCurrent] = useState<Locale>(getLocale());
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Stay in sync with programmatic locale changes (e.g. initLocale)
  useEffect(() => {
    return onLocaleChange(setCurrent);
  }, []);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSelect = async (locale: Locale) => {
    try {
      await ensureJobSlugMapLoaded();
    } catch {
      // Non-blocking: locale switch should still work even if the slug map preload fails.
    }
    setLocale(locale);
    updatePathForLocale(locale);
    setCurrent(locale);
    setIsOpen(false);
    Analytics.trackSettingsChange('locale', locale);
  };

  const currentLabel = LOCALE_LABELS[current];

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-1 px-2 py-1.5 rounded-xl text-sm text-muted hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
        title="Lingua / Language" aria-expanded={isOpen}
      >
        <span className="hidden sm:inline text-xs font-bold uppercase">{current.toUpperCase()}</span>
        <span className="sm:hidden">{currentLabel.flag}</span>
      </button>

      {isOpen && (
        <div className="absolute right-0 top-full mt-1 w-44 bg-surface border border-edge rounded-xl shadow-xl z-50 overflow-hidden animate-fade-in">
          {(Object.entries(LOCALE_LABELS) as [Locale, typeof LOCALE_LABELS[Locale]][]).map(([locale, label]) => (
            <button
              key={locale}
              onClick={() => handleSelect(locale)}
              className={`w-full flex items-center gap-3 px-4 py-2.5 text-sm transition-colors ${
                current === locale
                  ? 'bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 font-bold'
                  : 'text-body hover:bg-slate-50 dark:hover:bg-slate-700'
              }`}
            >
              <span className="text-lg">{label.flag}</span>
              <span>{label.nativeName}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export default LanguageSelector;
