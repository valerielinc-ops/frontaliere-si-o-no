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
      className="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded bg-surface-raised hover:bg-surface-raised transition-colors font-mono"
      title={`Copia: ${text}`}
      aria-label={`Copia ${label || text}`}
    >
      {copied ? <Check size={12} className="text-success" /> : <Copy size={12} className="text-muted" />}
      <span className="max-w-[200px] truncate">{text}</span>
    </button>
  );
}

