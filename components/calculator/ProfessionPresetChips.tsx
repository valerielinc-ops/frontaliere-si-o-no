import React from 'react';
import professionMedians from '@/data/profession-salary-medians.json';
import { useTranslation } from '@/services/i18n';
import { Analytics } from '../../services/analytics';

interface ProfessionPreset {
  id: string;
  label: { it: string; en: string; de: string; fr: string };
  medianSalaryChf: number;
  liveCount: number;
}

interface Props {
  annualIncomeCHF: number;
  onSelect: (chf: number) => void;
}

/**
 * 1-tap profession preset chips (issue #4307 scope item 4). Values come
 * from `data/profession-salary-medians.json`, a GENERATED file (never
 * hand-edit) produced by `scripts/generate-profession-salary-medians.mjs`
 * from the live jobs dataset — same median logic already shown on the
 * public profession-landing pages, so chips never drift from that number.
 * Mirrors the visual style of the existing round-number salary chips in
 * InputCard.tsx.
 */
export default function ProfessionPresetChips({ annualIncomeCHF, onSelect }: Props) {
  const { t, locale } = useTranslation();
  const presets = (professionMedians as { presets: ProfessionPreset[] }).presets;
  if (!presets || presets.length === 0) return null;

  return (
    <div className="mt-2">
      <p className="text-xs font-semibold text-muted mb-1.5">{t('input.professionPresetsLabel')}</p>
      <div className="flex gap-1.5 overflow-x-auto scrollbar-none pb-0.5">
        {presets.map((preset) => {
          const isSelected = annualIncomeCHF === preset.medianSalaryChf;
          const label = preset.label[locale] || preset.label.it;
          return (
            <button
              key={preset.id}
              type="button"
              onClick={() => {
                onSelect(preset.medianSalaryChf);
                Analytics.trackUIInteraction('simulatore', 'input', 'profession_preset', 'click', preset.id);
              }}
              aria-pressed={isSelected}
              className={`shrink-0 min-h-[44px] px-4 py-2 rounded-lg text-sm font-bold transition-colors ${
                isSelected
                  ? 'bg-accent-strong text-on-accent shadow-sm'
                  : 'bg-surface-raised text-subtle hover:bg-surface-raised'
              }`}
            >
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
