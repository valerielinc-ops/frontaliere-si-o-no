import React from 'react';
import { Info, AlertTriangle, CheckCircle, AlertCircle, Sparkles, MessageSquare } from 'lucide-react';

type CalloutStatus = 'info' | 'warning' | 'success' | 'danger' | 'accent' | 'neutral';
type CalloutVariant = 'tinted' | 'plain';

interface CalloutProps {
 status: CalloutStatus;
 variant?: CalloutVariant;
 icon?: React.ReactNode;
 children: React.ReactNode;
 className?: string;
}

const defaultIcons: Record<CalloutStatus, React.ReactNode> = {
 info: <Info size={20} />,
 warning: <AlertTriangle size={20} />,
 success: <CheckCircle size={20} />,
 danger: <AlertCircle size={20} />,
 accent: <Sparkles size={20} />,
 neutral: <MessageSquare size={20} />,
};

const tintedStyles: Record<CalloutStatus, string> = {
 info: 'bg-info-subtle border-info',
 warning: 'bg-warning-subtle border-warning',
 success: 'bg-success-subtle border-success',
 danger: 'bg-danger-subtle border-danger',
 accent: 'bg-accent-subtle border-accent',
 neutral: 'bg-neutral-subtle border-neutral',
};

const iconColor: Record<CalloutStatus, string> = {
 info: 'text-info',
 warning: 'text-warning',
 success: 'text-success',
 danger: 'text-danger',
 accent: 'text-accent',
 neutral: 'text-neutral',
};

export default function Callout({ status, variant = 'tinted', icon, children, className = '' }: CalloutProps) {
 const iconNode = icon ?? defaultIcons[status];

 if (variant === 'plain') {
  return (
   <div className={`flex items-start gap-3 ${className}`}>
    <span className={`${iconColor[status]} flex-shrink-0 mt-0.5`}>{iconNode}</span>
    <div className="flex-1 min-w-0">{children}</div>
   </div>
  );
 }

 return (
  <div className={`border-l-2 rounded-md p-4 ${tintedStyles[status]} ${className}`}>
   <div className="flex items-start gap-3">
    <span className={`${iconColor[status]} flex-shrink-0 mt-0.5`}>{iconNode}</span>
    <div className="flex-1 min-w-0">{children}</div>
   </div>
  </div>
 );
}
