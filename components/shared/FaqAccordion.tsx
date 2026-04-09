import { useState } from 'react';
import { ChevronDown, HelpCircle } from 'lucide-react';

interface FaqItem {
  question: string;
  answer: string;
}

interface FaqAccordionProps {
  title?: string;
  items: FaqItem[];
  className?: string;
}

export default function FaqAccordion({ title, items, className = '' }: FaqAccordionProps) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  return (
    <div className={`${className}`} data-speakable>
      {title && (
        <h2 className="text-lg font-bold text-slate-800 dark:text-white mb-4 flex items-center gap-2">
          <HelpCircle size={20} className="text-blue-600 dark:text-blue-400" />
          {title}
        </h2>
      )}
      <div className="space-y-2">
        {items.map((item, i) => (
          <div key={i} className="border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
            <button
              onClick={() => setOpenIndex(openIndex === i ? null : i)}
              className="w-full flex items-center justify-between px-4 py-3 text-left bg-white dark:bg-slate-800 hover:bg-slate-50 dark:hover:bg-slate-700/50 transition-colors"
              aria-expanded={openIndex === i}
              aria-controls={`faq-panel-${i}`}
              id={`faq-heading-${i}`}
            >
              <span className="font-medium text-slate-800 dark:text-white pr-4">{item.question}</span>
              <ChevronDown size={18} className={`flex-shrink-0 text-slate-500 dark:text-slate-400 transition-transform ${openIndex === i ? 'rotate-180' : ''}`} />
            </button>
            <div
              id={`faq-panel-${i}`}
              role="region"
              aria-labelledby={`faq-heading-${i}`}
              className={`overflow-hidden transition-[max-height] duration-200 ${openIndex === i ? 'max-h-96' : 'max-h-0'}`}
            >
              <div className="px-4 py-3 text-sm text-slate-600 dark:text-slate-400 bg-slate-50 dark:bg-slate-900/30 border-t border-slate-100 dark:border-slate-700">
                {item.answer}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
