import { isValidElement, createElement, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

export interface SegmentOption {
 key: string;
 label: string;
 icon?: LucideIcon | ReactNode;
}

interface SegmentControlProps {
 options: readonly SegmentOption[];
 value: string;
 onChange: (key: string) => void;
 /** Tailwind text class for the active segment, e.g. 'text-section-confronti' */
 activeTextClass?: string;
}

export function SegmentControl({
 options,
 value,
 onChange,
 activeTextClass = 'text-accent',
}: SegmentControlProps) {
 return (
 <div className="flex gap-1 bg-segment-container-bg rounded-xl p-1" role="group">
 {options.map((opt) => {
 const isActive = value === opt.key;
 const IconEl = opt.icon;
 return (
 <button
 key={opt.key}
 onClick={() => onChange(opt.key)}
 aria-pressed={isActive}
 className={`flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-bold transition-[color,background-color,box-shadow,transform] ${
 isActive
 ? `bg-segment-active-bg ${activeTextClass} shadow-sm`
 : 'text-muted hover:text-strong'
 }`}
 >
 {IconEl && (isValidElement(IconEl)
 ? IconEl
 : createElement(IconEl as LucideIcon, { size: 16 })
 )}
 <span className="hidden sm:inline">{opt.label}</span>
 </button>
 );
 })}
 </div>
 );
}
