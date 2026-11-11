import React, { useState } from 'react';

export interface CantonJobsData {
  cantonCode: 'TI' | 'GR' | 'ZH' | 'GE' | 'BS' | 'VS';
  name: string;
  count: number;
}

export interface SwissBubbleMapProps {
  data: CantonJobsData[];
  selectedCanton?: string | null;
  onSelectCanton: (cantonCode: string | null) => void;
  className?: string;
}

// Bounding box e poligoni vettoriali dei confini cantone/svizzera (<8KB)
export const SWISS_OUTLINE_PATH =
  'M 35 402 L 70 380 L 110 395 L 170 370 L 248 395 L 350 420 L 450 440 L 502 460 L 520 420 L 502 402 L 530 360 L 600 320 L 643 290 L 750 310 L 780 270 L 730 220 L 680 210 L 590 190 L 520 180 L 456 110 L 380 90 L 289 65 L 210 90 L 170 140 L 120 180 L 80 260 L 50 330 Z';

export const CANTON_CENTROIDS: Record<string, { x: number; y: number; name: string }> = {
  TI: { x: 502, y: 402, name: 'Ticino' },
  GR: { x: 643, y: 290, name: 'Grigioni' },
  ZH: { x: 456, y: 110, name: 'Zurigo' },
  GE: { x: 55, y: 395, name: 'Ginevra' },
  BS: { x: 289, y: 75, name: 'Basilea' },
  VS: { x: 248, y: 385, name: 'Vallese' },
};

export const SwissBubbleMap: React.FC<SwissBubbleMapProps> = ({
  data,
  selectedCanton,
  onSelectCanton,
  className = '',
}) => {
  const [hoveredCanton, setHoveredCanton] = useState<CantonJobsData | null>(null);
  const maxJobs = Math.max(1, ...data.map((d) => d.count));

  const getRadius = (count: number) => {
    if (count <= 0) return 0;
    const minR = 9;
    const maxR = 32;
    return minR + (maxR - minR) * Math.sqrt(count / maxJobs);
  };

  const handleCantonClick = (code: string) => {
    if (selectedCanton === code) {
      onSelectCanton(null); // Toggle off
    } else {
      onSelectCanton(code);
    }
  };

  return (
    <div className={`relative w-full max-w-3xl mx-auto select-none ${className}`} data-testid="swiss-bubble-map">
      <svg
        viewBox="0 0 800 500"
        className="w-full h-auto drop-shadow-sm transition-all"
        role="region"
        aria-label="Mappa offerte per Cantone Svizzero"
      >
        {/* Sagoma Vettoriale Svizzera */}
        <path
          d={SWISS_OUTLINE_PATH}
          className="fill-slate-100 stroke-slate-300 dark:fill-slate-800 dark:stroke-slate-700"
          strokeWidth="2"
          strokeLinejoin="round"
        />

        {/* Bolle per Cantone */}
        {data.map((item) => {
          const centroid = CANTON_CENTROIDS[item.cantonCode];
          if (!centroid || item.count <= 0) return null;
          const radius = getRadius(item.count);
          const isSelected = selectedCanton === item.cantonCode;

          return (
            <g
              key={item.cantonCode}
              data-testid={`canton-bubble-${item.cantonCode}`}
              className="cursor-pointer group"
              onClick={() => handleCantonClick(item.cantonCode)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  handleCantonClick(item.cantonCode);
                }
              }}
              onMouseEnter={() => setHoveredCanton(item)}
              onMouseLeave={() => setHoveredCanton(null)}
              tabIndex={0}
              role="button"
              aria-label={`${centroid.name}: ${item.count} offerte di lavoro disponibili`}
              aria-pressed={isSelected}
            >
              {/* Alone esterno di hover / selezione */}
              <circle
                cx={centroid.x}
                cy={centroid.y}
                r={radius + 4}
                className={`transition-all duration-300 ${
                  isSelected
                    ? 'fill-red-500/20 stroke-red-500 stroke-2'
                    : 'fill-transparent group-hover:fill-red-500/10'
                }`}
              />

              {/* Bolla primaria del Cantone */}
              <circle
                cx={centroid.x}
                cy={centroid.y}
                r={radius}
                className={`transition-all duration-200 ${
                  isSelected
                    ? 'fill-red-600 stroke-white dark:stroke-slate-900 stroke-2'
                    : 'fill-red-500/80 hover:fill-red-600 stroke-white/80 dark:stroke-slate-800'
                }`}
              />

              {/* Codice Cantone e conteggio */}
              <text
                x={centroid.x}
                y={centroid.y - 1}
                textAnchor="middle"
                dominantBaseline="central"
                className="fill-white font-bold text-xs pointer-events-none drop-shadow"
              >
                {item.cantonCode}
              </text>
            </g>
          );
        })}
      </svg>

      {/* Tooltip Dinamico Fluttuante */}
      {hoveredCanton && (
        <div
          data-testid="canton-tooltip"
          className="absolute pointer-events-none px-3 py-1.5 bg-slate-900/90 text-white rounded-lg shadow-xl text-xs flex flex-col items-center gap-0.5 transform -translate-x-1/2 -translate-y-full transition-all"
          style={{
            left: `${(CANTON_CENTROIDS[hoveredCanton.cantonCode].x / 800) * 100}%`,
            top: `${(CANTON_CENTROIDS[hoveredCanton.cantonCode].y / 500) * 100 - 4}%`,
          }}
        >
          <span className="font-semibold">{hoveredCanton.name}</span>
          <span className="text-slate-300">{hoveredCanton.count.toLocaleString('it-CH')} offerte</span>
        </div>
      )}
    </div>
  );
};
