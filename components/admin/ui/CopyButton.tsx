import { useState } from 'react';
import { Check, Copy } from 'lucide-react';

export function CopyButton({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <button
      type="button"
      onClick={() => void handleCopy()}
      className="inline-flex min-h-10 min-w-0 max-w-full items-center gap-1.5 rounded-stripe border border-edge bg-surface px-3 py-2 text-sm font-medium text-body transition-colors hover:border-accent hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      title={`Copia: ${text}`}
      aria-label={`Copia ${label || text}`}
    >
      {copied ? <Check size={15} className="text-success" aria-hidden="true" /> : <Copy size={15} className="text-muted" aria-hidden="true" />}
      <span className="min-w-0 max-w-[200px] truncate">{text}</span>
    </button>
  );
}

