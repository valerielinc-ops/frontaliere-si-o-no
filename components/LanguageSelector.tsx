import React, { useState, useRef, useEffect } from 'react';
import { Globe } from 'lucide-react';
import { type Locale, getLocale, setLocale, LOCALE_LABELS } from '@/services/i18n';
import { Analytics } from '@/services/analytics';

const LanguageSelector: React.FC = () => {
  const [isOpen, setIsOpen] = useState(false);
  const [current, setCurrent] = useState<Locale>(getLocale());
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSelect = (locale: Locale) => {
    setLocale(locale);
    setCurrent(locale);
    setIsOpen(false);
    Analytics.trackSettingsChange('locale', locale);
  };

  const currentLabel = LOCALE_LABELS[current];

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-sm text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
        title="Lingua / Language"
      >
        <Globe size={16} />
        <span className="hidden sm:inline text-xs font-bold uppercase">{currentLabel.flag} {current.toUpperCase()}</span>
        <span className="sm:hidden">{currentLabel.flag}</span>
      </button>

      {isOpen && (
        <div className="absolute right-0 top-full mt-1 w-44 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl shadow-xl z-50 overflow-hidden animate-fade-in">
          {(Object.entries(LOCALE_LABELS) as [Locale, typeof LOCALE_LABELS[Locale]][]).map(([locale, label]) => (
            <button
              key={locale}
              onClick={() => handleSelect(locale)}
              className={`w-full flex items-center gap-3 px-4 py-2.5 text-sm transition-colors ${
                current === locale
                  ? 'bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 font-bold'
                  : 'text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-750'
              }`}
            >
              <span className="text-lg">{label.flag}</span>
              <span>{label.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export default LanguageSelector;
