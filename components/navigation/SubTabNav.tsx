import type { LucideIcon } from 'lucide-react';

export interface SubTabItem<K extends string = string> {
 key: K;
 icon: LucideIcon;
 label: string;
}

interface SubTabNavProps<K extends string> {
 items: readonly SubTabItem<K>[];
 activeKey: K;
 onSelect: (key: K) => void;
}

export function SubTabNav<K extends string>({ items, activeKey, onSelect }: SubTabNavProps<K>) {
 return (
 <div className="border-t border-edge bg-surface">
 <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-1 md:py-2.5">
 <div className="flex md:grid md:grid-cols-8 gap-1.5 overflow-x-auto md:overflow-x-visible scrollbar-hide pr-6 md:pr-0 py-0.5">
 {items.map(({ key, icon: Icon, label }) => (
 <button
 key={key}
 data-subtab-active={activeKey === key ? 'true' : undefined}
 onClick={() => onSelect(key)}
 className={`flex items-center md:flex-col gap-1.5 md:gap-0.5 px-3 md:px-1 py-1.5 md:py-1.5 min-h-[44px] md:min-h-0 rounded-xl text-xs sm:text-sm font-semibold transition-[color,background-color,border-color,box-shadow] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 shrink-0 md:shrink ${
 activeKey === key
 ? 'bg-tab-active-bg text-tab-active-text ring-2 ring-tab-active-border'
 : 'text-tab-inactive-text hover:bg-tab-hover-bg'
 }`}
 >
 <Icon size={18} className="hidden md:block" aria-hidden="true" />
 <span className="leading-tight text-center whitespace-nowrap md:whitespace-normal md:w-full md:line-clamp-2">{label}</span>
 </button>
 ))}
 </div>
 </div>
 </div>
 );
}
