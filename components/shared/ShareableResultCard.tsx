/**
 * ShareableResultCard — Generate branded shareable images from calculator results
 *
 * Renders calculation results as a branded card, draws it directly onto a
 * Canvas 2D context (no html2canvas — avoids oklch/Tailwind CSS 4 issues),
 * and provides download + share buttons (WhatsApp, native share, copy).
 * Integrates into any calculator's results section.
 */

import React, { useState, useRef, useCallback } from 'react';
import { useTranslation } from '@/services/i18n';
import { Analytics } from '@/services/analytics';
import { reportCaughtError } from '@/services/errorReporter';
import {
  Share2, MessageCircle, Copy, Check,
  Camera, X, Image as ImageIcon, Loader2
} from 'lucide-react';

// ─── Types ──────────────────────────────────────────────────────────────

export interface CardDataRow {
  label: string;
  value: string;
  highlight?: boolean;
  color?: 'emerald' | 'blue' | 'amber' | 'red' | 'violet';
}

export interface ShareableCardProps {
  /** Card title (e.g., "Simulazione Stipendio Netto") */
  title: string;
  /** Subtitle / context line */
  subtitle?: string;
  /** Key data rows to display */
  rows: CardDataRow[];
  /** Optional footer text */
  footer?: string;
  /** Gradient accent: 'blue' | 'violet' | 'emerald' | 'amber' */
  accent?: 'blue' | 'violet' | 'emerald' | 'amber';
  /** Context for analytics */
  context?: string;
}

// ─── Color maps ─────────────────────────────────────────────────────────

/** Tailwind classes for the visible card preview */
const ACCENT_GRADIENTS: Record<string, string> = {
  blue: 'from-blue-600 to-blue-700',
  violet: 'from-violet-600 to-purple-700',
  emerald: 'from-emerald-600 to-teal-700',
  amber: 'from-amber-500 to-orange-600',
};

/** Hex pairs for Canvas 2D gradient drawing */
const ACCENT_HEX: Record<string, [string, string]> = {
  blue: ['#2563eb', '#4338ca'],
  violet: ['#7c3aed', '#7e22ce'],
  emerald: ['#059669', '#0f766e'],
  amber: ['#f59e0b', '#ea580c'],
};

const ROW_COLORS: Record<string, string> = {
  emerald: 'text-emerald-700',
  blue: 'text-blue-700',
  amber: 'text-amber-700',
  red: 'text-red-700',
  violet: 'text-violet-700',
};

/** Hex values for Canvas row value colors */
const ROW_HEX: Record<string, string> = {
  emerald: '#047857',
  blue: '#1d4ed8',
  amber: '#b45309',
  red: '#b91c1c',
  violet: '#6d28d9',
};

/** Dark-mode hex values for Canvas row value colors */
const ROW_HEX_DARK: Record<string, string> = {
  emerald: '#34d399',
  blue: '#60a5fa',
  amber: '#fbbf24',
  red: '#f87171',
  violet: '#a78bfa',
};

// ─── Canvas drawing helpers ─────────────────────────────────────────────

/** Draw a rounded rectangle path */
function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

/** Word-wrap text and return lines */
function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** Draw the card onto a canvas and return a data URL */
function drawCardToCanvas(
  title: string,
  subtitle: string | undefined,
  rows: CardDataRow[],
  footerText: string,
  accent: string,
  isDark: boolean = false,
): string {
  const scale = 2;
  const W = 600; // logical width
  const PAD = 24;
  const HEADER_H = 72;
  const ROW_H = 36;
  const FOOTER_H = 40;
  const totalH = HEADER_H + PAD + rows.length * ROW_H + PAD + FOOTER_H;

  const canvas = document.createElement('canvas');
  canvas.width = W * scale;
  canvas.height = totalH * scale;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(scale, scale);

  // ── Palette ──
  const bgColor = isDark ? '#0f172a' : '#ffffff';
  const footerBg = isDark ? '#1e293b' : '#f8fafc';
  const footerTxt = isDark ? '#94a3b8' : '#94a3b8';
  const footerBrand = isDark ? '#cbd5e1' : '#64748b';
  const labelColor = (highlight: boolean) => isDark
    ? (highlight ? '#f1f5f9' : '#94a3b8')
    : (highlight ? '#1e293b' : '#475569');
  const valueColor = (highlight: boolean) => isDark
    ? (highlight ? '#f1f5f9' : '#cbd5e1')
    : (highlight ? '#0f172a' : '#334155');
  const dividerColor = (highlight: boolean) => isDark
    ? (highlight ? '#475569' : '#334155')
    : (highlight ? '#e2e8f0' : '#f1f5f9');
  const rowHex = isDark ? ROW_HEX_DARK : ROW_HEX;

  // ── Background with rounded corners ──
  ctx.fillStyle = bgColor;
  roundRect(ctx, 0, 0, W, totalH, 16);
  ctx.fill();
  // Clip so header gradient respects top radius
  ctx.save();
  roundRect(ctx, 0, 0, W, totalH, 16);
  ctx.clip();

  // ── Header gradient ──
  const [c1, c2] = ACCENT_HEX[accent] || ACCENT_HEX.blue;
  const grad = ctx.createLinearGradient(0, 0, W, 0);
  grad.addColorStop(0, c1);
  grad.addColorStop(1, c2);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, HEADER_H);

  // Icon placeholder (white circle with 🧮 emoji)
  ctx.fillStyle = 'rgba(255,255,255,0.2)';
  roundRect(ctx, PAD, 16, 40, 40, 10);
  ctx.fill();
  ctx.font = '20px sans-serif';
  ctx.fillStyle = '#ffffff';
  ctx.fillText('📊', PAD + 10, 42);

  // Title
  ctx.font = 'bold 18px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.fillStyle = '#ffffff';
  const titleLines = wrapText(ctx, title, W - PAD * 2 - 56);
  ctx.fillText(titleLines[0] || title, PAD + 52, subtitle ? 32 : 40);
  if (titleLines[1]) ctx.fillText(titleLines[1], PAD + 52, 50);

  // Subtitle
  if (subtitle) {
    ctx.font = '13px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.fillText(subtitle, PAD + 52, 52);
  }

  // ── Data rows ──
  let y = HEADER_H + PAD;
  for (const row of rows) {
    // Separator line
    ctx.strokeStyle = dividerColor(row.highlight ?? false);
    ctx.lineWidth = row.highlight ? 2 : 1;
    ctx.beginPath();
    ctx.moveTo(PAD, y + ROW_H - 1);
    ctx.lineTo(W - PAD, y + ROW_H - 1);
    ctx.stroke();

    // Label
    ctx.font = row.highlight
      ? '600 13px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
      : '13px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.fillStyle = labelColor(row.highlight ?? false);
    ctx.textAlign = 'left';
    ctx.fillText(row.label, PAD, y + 22);

    // Value
    ctx.font = 'bold 13px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.fillStyle = row.color
      ? (rowHex[row.color] || valueColor(true))
      : valueColor(row.highlight ?? false);
    ctx.textAlign = 'right';
    ctx.fillText(row.value, W - PAD, y + 22);
    ctx.textAlign = 'left';

    y += ROW_H;
  }

  // ── Footer ──
  const footerY = totalH - FOOTER_H;
  ctx.fillStyle = footerBg;
  ctx.fillRect(0, footerY, W, FOOTER_H);

  ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.fillStyle = footerTxt;
  ctx.textAlign = 'left';
  ctx.fillText(footerText, PAD, footerY + 24);

  ctx.font = '600 11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.fillStyle = footerBrand;
  ctx.textAlign = 'right';
  ctx.fillText('frontaliereticino.ch', W - PAD, footerY + 24);
  ctx.textAlign = 'left';

  ctx.restore(); // remove clip

  return canvas.toDataURL('image/png');
}

// ─── Component ──────────────────────────────────────────────────────────

const ShareableResultCard: React.FC<ShareableCardProps> = ({
  title,
  subtitle,
  rows,
  footer,
  accent = 'blue',
  context = 'calculator',
}) => {
  const { t } = useTranslation();
  const cardRef = useRef<HTMLDivElement>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatedImage, setGeneratedImage] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [showCard, setShowCard] = useState(false);

  // ─── Generate image via Canvas 2D (no html2canvas) ──────────────────

  const generateAndDownload = useCallback(async () => {
    if (isGenerating) return;
    setIsGenerating(true);

    try {
      const footerText = footer || t('shareCard.generatedBy');
      const isDark = document.documentElement.classList.contains('dark');
      const dataUrl = drawCardToCanvas(title, subtitle, rows, footerText, accent, isDark);
      setGeneratedImage(dataUrl);

      // Immediate download
      const link = document.createElement('a');
      link.download = `frontaliere-ticino-${context}-${Date.now()}.png`;
      link.href = dataUrl;
      link.click();

      Analytics.trackUIInteraction('shareable_card', context, 'generate', title);
      Analytics.trackShare('download', 'result_card', context);
    } catch (err) {
      console.warn('Failed to generate image:', err);
      reportCaughtError(err, 'shareableCard.generateImage');
    } finally {
      setIsGenerating(false);
    }
  }, [isGenerating, context, title, subtitle, rows, footer, accent, t]);

  // ─── Share via WhatsApp ─────────────────────────────────────────────

  const shareWhatsApp = useCallback(() => {
    const text = `${title}\n${rows.filter(r => r.highlight).map(r => `${r.label}: ${r.value}`).join('\n')}\n\n${t('shareCard.whatsappFooter')}\nhttps://frontaliereticino.ch`;
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank');
    Analytics.trackShare('whatsapp', 'result_card', context);
  }, [title, rows, t, context]);

  // ─── Native share ───────────────────────────────────────────────────

  const downloadImage = useCallback(() => {
    if (!generatedImage) return;
    const a = document.createElement('a');
    a.href = generatedImage;
    a.download = 'frontaliere-result.png';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    Analytics.trackShare('download', 'result_card', context);
  }, [generatedImage, context]);

  const shareNative = useCallback(async () => {
    if (!generatedImage) {
      // Fall back to text sharing
      const text = `${title}\n${rows.filter(r => r.highlight).map(r => `${r.label}: ${r.value}`).join('\n')}\nhttps://frontaliereticino.ch`;
      try {
        if (navigator.share) {
          await navigator.share({ title, text, url: 'https://frontaliereticino.ch' });
        } else {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        }
      } catch { /* user cancelled */ }
    } else {
      // Share with image if supported
      try {
        const response = await fetch(generatedImage);
        const blob = await response.blob();
        const file = new File([blob], 'frontaliere-result.png', { type: 'image/png' });
        if (navigator.share && navigator.canShare?.({ files: [file] })) {
          await navigator.share({
            title,
            text: rows.filter(r => r.highlight).map(r => `${r.label}: ${r.value}`).join(' | '),
            files: [file],
          });
        } else {
          downloadImage();
        }
      } catch {
        downloadImage();
      }
    }
    Analytics.trackShare('native', 'result_card', context);
  }, [generatedImage, title, rows, downloadImage, context]);

  // ─── Copy data to clipboard ─────────────────────────────────────────

  const copyData = useCallback(async () => {
    const text = `${title}\n${'─'.repeat(30)}\n${rows.map(r => `${r.label}: ${r.value}`).join('\n')}\n${'─'.repeat(30)}\n${footer || ''}\nhttps://frontaliereticino.ch`;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    Analytics.trackShare('copy_link', 'result_card', context);
  }, [title, rows, footer, context]);

  // ─── Render ─────────────────────────────────────────────────────────

  return (
    <div className="mt-6">
      {/* Toggle button */}
      {!showCard && (
        <button
          onClick={() => { setShowCard(true); generateAndDownload(); }}
          disabled={isGenerating}
          className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl text-sm font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 disabled:opacity-50 transition-colors"
          aria-label={t('shareCard.createCard')}
        >
          {isGenerating ? <Loader2 size={16} className="animate-spin text-violet-500" /> : <Camera size={16} className="text-violet-500" />}
          {t('shareCard.createCard')}
        </button>
      )}

      {showCard && (
        <div className="space-y-4">
          {/* Close button */}
          <div className="flex justify-end">
            <button
              onClick={() => { setShowCard(false); setGeneratedImage(null); }}
              className="text-slate-500 dark:text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
              aria-label={t('shareCard.close')}
            >
              <X size={18} />
            </button>
          </div>

          {/* The Card (hidden when image is generated) */}
          <div
            ref={cardRef}
            className="bg-white dark:bg-slate-800 rounded-2xl overflow-hidden shadow-lg w-full max-w-[600px]"
          >
            {/* Header */}
            <div className={`bg-gradient-to-r ${ACCENT_GRADIENTS[accent]} px-6 py-4`}>
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-white/20 rounded-xl flex items-center justify-center">
                  <ImageIcon size={20} className="text-white" />
                </div>
                <div>
                  <h3 className="font-bold text-white text-lg">{title}</h3>
                  {subtitle && <p className="text-white/90 text-sm">{subtitle}</p>}
                </div>
              </div>
            </div>

            {/* Data Rows */}
            <div className="px-6 py-4 space-y-2">
              {rows.map((row, i) => (
                <div
                  key={i}
                  className={`flex items-center justify-between py-2 ${
                    row.highlight ? 'border-b-2 border-slate-200 dark:border-slate-700' : 'border-b border-slate-100 dark:border-slate-700'
                  }`}
                >
                  <span className={`text-sm ${row.highlight ? 'font-semibold text-slate-800 dark:text-slate-200' : 'text-slate-600 dark:text-slate-400'}`}>
                    {row.label}
                  </span>
                  <span className={`text-sm font-bold ${
                    row.color ? ROW_COLORS[row.color] || 'text-slate-800' : row.highlight ? 'text-slate-900' : 'text-slate-700 dark:text-slate-300'
                  }`}>
                    {row.value}
                  </span>
                </div>
              ))}
            </div>

            {/* Footer */}
            <div className="px-6 py-3 bg-slate-50 flex items-center justify-between">
              <span className="text-xs text-slate-500 dark:text-slate-400">
                {footer || t('shareCard.generatedBy')}
              </span>
              <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">
                frontaliereticino.ch
              </span>
            </div>
          </div>

          {/* Action Buttons */}
          <div className="flex flex-wrap gap-2">
            {/* WhatsApp */}
            <button
              onClick={shareWhatsApp}
              className="flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-700 text-white text-sm font-medium rounded-xl transition-colors"
              aria-label={t('shareCard.shareWhatsApp')}
            >
              <MessageCircle size={16} />
              WhatsApp
            </button>

            {/* Share / Copy */}
            <button
              onClick={generatedImage ? shareNative : copyData}
              className="flex items-center gap-2 px-4 py-2 bg-slate-600 hover:bg-slate-700 text-white text-sm font-medium rounded-xl transition-colors"
              aria-label={copied ? t('shareCard.copied') : t('shareCard.share')}
            >
              {copied ? <Check size={16} /> : generatedImage ? <Share2 size={16} /> : <Copy size={16} />}
              {copied ? t('shareCard.copied') : t('shareCard.share')}
            </button>
          </div>

          {/* Preview of generated image */}
          {generatedImage && (
            <div className="rounded-xl overflow-hidden border border-slate-200 dark:border-slate-700">
              <img
                src={generatedImage}
                alt={t('shareCard.previewAlt')}
                className="w-full"
                width={600}
                height={400}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default ShareableResultCard;
