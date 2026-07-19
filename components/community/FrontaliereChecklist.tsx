import React, { useState, useCallback } from 'react';
import {
  Compass,
  CheckCircle2,
  Circle,
  ChevronRight,
  RotateCcw,
  PartyPopper,
  Zap,
  IdCard,
  FileSignature,
  Landmark,
  HeartPulse,
  Car,
  Receipt,
  Wallet,
  Sunrise,
} from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import { buildPath, type AppRoute } from '@/services/router';
import { Analytics } from '@/services/analyticsProxy';
import { addXp, unlockAchievement } from '@/services/gamificationService';
import {
  CHECKLIST_STEPS,
  XP_PER_STEP,
  CHECKLIST_COMPLETE_ACHIEVEMENT,
  loadChecklistState,
  saveChecklistState,
  doneCount,
  isAllDone,
  type ChecklistState,
} from '@/services/frontaliereChecklist';

// Per-step icon (view concern — kept out of the pure data module).
const STEP_ICONS: Record<string, React.ComponentType<{ size?: number; className?: string }>> = {
  permesso_g: IdCard,
  contratto: FileSignature,
  conto_chf: Landmark,
  lamal: HeartPulse,
  dogana_targa: Car,
  imposta_fonte: Receipt,
  prima_busta: Wallet,
  primo_giorno: Sunrise,
};

/** Client-side navigation to an internal route (same pattern as SiteMapPage). */
function navigateToRoute(route: AppRoute): void {
  const href = buildPath(route);
  window.history.pushState(null, '', href);
  window.dispatchEvent(new PopStateEvent('popstate'));
  window.scrollTo({ top: 0, behavior: 'instant' });
}

const TOTAL = CHECKLIST_STEPS.length;

const FrontaliereChecklist: React.FC = () => {
  const { t, locale } = useTranslation();
  // Read synchronously on mount from localStorage → no async swap, no CLS.
  const [state, setState] = useState<ChecklistState>(loadChecklistState);

  const done = doneCount(state);
  const allDone = isAllDone(state);
  const progressPct = TOTAL > 0 ? done / TOTAL : 0;

  const toggle = useCallback((stepId: string) => {
    const next = loadChecklistState();
    const wasDone = !!next.done[stepId];

    if (wasDone) {
      delete next.done[stepId];
    } else {
      next.done[stepId] = Date.now();
      // XP granted at most once per step, ever (anti-farm on re-check).
      if (!next.awarded[stepId]) {
        next.awarded[stepId] = true;
        addXp(XP_PER_STEP);
      }
      Analytics.trackEvent('checklist_step_done', {
        step: stepId,
        done: doneCount(next),
        total: TOTAL,
      });
    }

    if (isAllDone(next) && !next.completedAt) {
      next.completedAt = Date.now();
      unlockAchievement(CHECKLIST_COMPLETE_ACHIEVEMENT); // +50 XP + achievement toast
      Analytics.trackEvent('checklist_completed', { total: TOTAL });
    }

    saveChecklistState(next);
    setState({ ...next });
  }, []);

  const reset = useCallback(() => {
    const next = loadChecklistState();
    // Keep `awarded` (XP already earned is permanent) and `completedAt`; only
    // clear the current checked state so the user can walk the path again.
    next.done = {};
    saveChecklistState(next);
    setState({ ...next });
  }, []);

  return (
    <section
      aria-labelledby="frontaliere-checklist-title"
      className="bg-surface rounded-2xl border border-edge overflow-hidden"
    >
      {/* Header */}
      <div className="bg-gradient-to-r from-success-strong to-info-strong text-on-accent p-5 sm:p-6">
        <div className="flex items-start gap-4">
          <div className="w-12 h-12 rounded-xl bg-on-accent/20 flex items-center justify-center flex-shrink-0">
            <Compass size={26} className="text-on-accent" />
          </div>
          <div className="min-w-0">
            <div className="inline-flex items-center gap-1.5 bg-on-accent/20 px-2.5 py-0.5 rounded-full text-xs font-bold mb-1.5">
              {t('checklist.badge')}
            </div>
            <h2 id="frontaliere-checklist-title" className="text-xl sm:text-2xl font-bold font-display leading-tight">
              {t('checklist.title')}
            </h2>
            <p className="text-on-accent/80 text-sm mt-1">{t('checklist.subtitle')}</p>
          </div>
        </div>

        {/* Progress — transform-based fill avoids reflow/CLS */}
        <div className="mt-5">
          <div className="flex items-center justify-between text-xs font-semibold mb-1.5">
            <span>{t('checklist.progress', { done, total: TOTAL })}</span>
            <span className="inline-flex items-center gap-1">
              <Zap size={12} className="text-on-accent" />
              {t('checklist.xpHint', { xp: XP_PER_STEP })}
            </span>
          </div>
          <div
            className="h-2 bg-on-accent/20 rounded-full overflow-hidden"
            role="progressbar"
            aria-valuenow={done}
            aria-valuemin={0}
            aria-valuemax={TOTAL}
          >
            <div
              className="h-full bg-surface rounded-full transition-transform duration-500 origin-left [transform:var(--sx)]"
              style={{ ['--sx']: `scaleX(${progressPct})` } as React.CSSProperties}
            />
          </div>
        </div>
      </div>

      {/* Completion banner — reserved via conditional block below the header, no shift on steps */}
      {allDone && (
        <div className="flex items-center gap-2.5 bg-success-subtle border-b border-success-border px-5 py-3 text-sm text-success font-semibold">
          <PartyPopper size={18} className="flex-shrink-0" />
          {t('checklist.completedBanner')}
        </div>
      )}

      {/* Steps */}
      <ol className="divide-y divide-edge">
        {CHECKLIST_STEPS.map((step, idx) => {
          const Icon = STEP_ICONS[step.id] ?? Circle;
          const isDone = !!state.done[step.id];
          const href = buildPath(step.route, locale);
          return (
            <li key={step.id} className="flex items-center gap-3 p-4">
              {/* Checkbox toggle */}
              <button
                type="button"
                onClick={() => toggle(step.id)}
                aria-pressed={isDone}
                aria-label={`${t(step.titleKey)} — ${isDone ? t('checklist.markUndone') : t('checklist.markDone')}`}
                className="flex-shrink-0 text-2xl transition-transform active:scale-90"
              >
                {isDone
                  ? <CheckCircle2 size={26} className="text-success" />
                  : <Circle size={26} className="text-muted" />}
              </button>

              {/* Icon + text */}
              <div className="flex items-center gap-3 min-w-0 flex-1">
                <div className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 ${isDone ? 'bg-success-subtle' : 'bg-surface-raised'}`}>
                  <Icon size={18} className={isDone ? 'text-success' : 'text-subtle'} />
                </div>
                <div className="min-w-0">
                  <h3 className={`text-sm font-semibold leading-tight ${isDone ? 'text-muted line-through' : 'text-body'}`}>
                    <span className="text-muted font-bold mr-1">{idx + 1}.</span>
                    {t(step.titleKey)}
                  </h3>
                  <p className="text-xs text-muted mt-0.5 line-clamp-2">{t(step.descKey)}</p>
                </div>
              </div>

              {/* Guide link */}
              <a
                href={href}
                onClick={(e) => { e.preventDefault(); navigateToRoute(step.route); }}
                className="flex-shrink-0 inline-flex items-center gap-1 px-3 py-2 min-h-[44px] rounded-lg text-xs font-semibold text-accent hover:bg-accent-subtle transition-colors whitespace-nowrap"
              >
                <span className="hidden sm:inline">{t('checklist.stepCta')}</span>
                <ChevronRight size={16} />
              </a>
            </li>
          );
        })}
      </ol>

      {/* Footer */}
      <div className="flex items-center justify-between gap-3 px-4 py-3 bg-surface-raised/50 border-t border-edge">
        <p className="text-xs text-muted">{t('checklist.footerNote')}</p>
        {done > 0 && (
          <button
            type="button"
            onClick={reset}
            className="inline-flex items-center gap-1.5 px-3 py-2 min-h-[44px] rounded-lg text-xs font-semibold text-subtle hover:bg-surface-raised transition-colors flex-shrink-0"
          >
            <RotateCcw size={14} />
            {t('checklist.reset')}
          </button>
        )}
      </div>
    </section>
  );
};

export default FrontaliereChecklist;
