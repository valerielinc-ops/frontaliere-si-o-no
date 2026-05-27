import React, { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';

interface Props {
 delta: number;
 currency?: string;
 size?: 'desktop' | 'mobile';
}

function formatDeltaText(delta: number, currency: string, size: 'desktop' | 'mobile') {
 const absolute = Math.abs(delta).toLocaleString('it-IT');
 if (delta > 0) return `+${currency} ${absolute}`;
 if (size === 'mobile') return `-${currency} ${absolute}`;
 return `${currency} ${absolute}`;
}

const InlineNetDeltaBadge: React.FC<Props> = ({ delta, currency = 'CHF', size = 'desktop' }) => {
 const [visible, setVisible] = useState(true);

 useEffect(() => {
 setVisible(true);
 }, [delta]);

 if (Math.abs(delta) < 1 || !visible) return null;

 const isPositive = delta > 0;
 const baseClasses =
 size === 'mobile'
 ? 'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-bold font-mono'
 : 'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold font-mono pointer-events-none select-none';
 const toneClasses = isPositive
 ? 'animate-net-tick-up bg-success-subtle text-success'
 : 'animate-net-tick-down bg-danger-subtle text-danger';
 const iconSize = size === 'mobile' ? 10 : 10;

 return (
 <span
 className={`${baseClasses} ${toneClasses}`}
 aria-live="polite"
 aria-atomic="true"
 onAnimationEnd={() => setVisible(false)}
 >
 {isPositive ? <ArrowUp size={iconSize} strokeWidth={3} /> : <ArrowDown size={iconSize} strokeWidth={3} />}
 {formatDeltaText(delta, currency, size as 'desktop' | 'mobile')}
 </span>
 );
};

export default InlineNetDeltaBadge;
