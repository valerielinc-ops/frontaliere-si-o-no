import React, { useEffect, useRef, useState } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { buildPath } from '@/services/router';
import { useTranslation } from '@/services/i18n';
import { Analytics } from '@/services/analytics';
import { useNavigationOptional } from '@/services/NavigationContext';

interface Props {
  /** Gross annual CHF income currently in the calculator's inputs. */
  annualIncomeCHF: number;
}

const DEFAULT_CANTON = 'TI';
const BAND_RATIO = 0.15;

function readCantonFromUrl(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const params = new URLSearchParams(window.location.search || '');
    const raw = params.get('cantone');
    return raw ? raw.trim().toUpperCase() : null;
  } catch {
    return null;
  }
}

/** Strip `?cantone=` from the URL after reading it, without touching any other param. */
function stripCantonFromUrl(): void {
  if (typeof window === 'undefined') return;
  try {
    const params = new URLSearchParams(window.location.search || '');
    if (!params.has('cantone')) return;
    params.delete('cantone');
    const qs = params.toString();
    const newUrl = `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`;
    window.history.replaceState(window.history.state, '', newUrl);
  } catch { /* non-critical */ }
}

/**
 * Reverse bridge (issue #4307 scope item 3): "Offerte nella tua fascia
 * (±15%) in <cantone>" — links from the calculator's result to the job
 * board, filtered to a ±15% salary band via `?salarioMin=&salarioMax=`
 * (read by components/community/JobBoard.tsx's `readSalaryRangeFromUrl`).
 *
 * Also doubles as the deep-link ARRIVAL tracker (scope item 2): when the
 * job board's "netto stimato" widget links into the calculator with
 * `?cantone=XX`, this component reads it once, records the canton for the
 * outgoing link, fires `trackCalculatorDeepLinkArrival`, then strips the
 * param so it doesn't linger in the URL bar.
 */
export default function CalculatorJobBridge({ annualIncomeCHF }: Props) {
  const { t, locale } = useTranslation();
  const nav = useNavigationOptional();
  const [canton, setCanton] = useState(DEFAULT_CANTON);
  const arrivalTracked = useRef(false);

  useEffect(() => {
    const fromUrl = readCantonFromUrl();
    if (!fromUrl) return;
    setCanton(fromUrl);
    if (!arrivalTracked.current) {
      arrivalTracked.current = true;
      Analytics.trackCalculatorDeepLinkArrival('job_widget');
    }
    stripCantonFromUrl();
  }, []);

  if (!annualIncomeCHF || annualIncomeCHF <= 0) return null;

  const min = Math.max(0, Math.round(annualIncomeCHF * (1 - BAND_RATIO)));
  const max = Math.round(annualIncomeCHF * (1 + BAND_RATIO));
  const href = `${buildPath({ activeTab: 'job-board', jobBoardCanton: canton }, locale)}?salarioMin=${min}&salarioMax=${max}`;

  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault();
    // matchedCount is unknown client-side (calculator doesn't load the jobs
    // dataset) — -1 is the documented "not computed" sentinel; the job
    // board shows the real count once it lands.
    Analytics.trackReverseBridgeClick(canton, -1);
    if (nav) {
      nav.navigateTo('job-board', undefined, canton);
      // Mirror JobBoard's own deep-link pattern: pushRoute only preserves
      // an allowlist of query params, so append the salary band manually.
      const url = `${buildPath({ activeTab: 'job-board', jobBoardCanton: canton }, locale)}?salarioMin=${min}&salarioMax=${max}`;
      window.history.replaceState(window.history.state, '', url);
    } else {
      window.location.href = href;
    }
  };

  return (
    <div className="mt-6 rounded-2xl border border-edge bg-surface-alt/50 p-4 sm:p-5">
      <p className="text-sm font-bold text-heading mb-2">
        {t('results.jobBridge.title', { canton })}
      </p>
      <a
        href={href}
        onClick={handleClick}
        className="inline-flex items-center gap-1.5 text-sm font-semibold text-link hover:underline"
      >
        {t('results.jobBridge.cta')}
        <ArrowUpRight size={15} />
      </a>
    </div>
  );
}
