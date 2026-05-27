/**
 * pdfReport.ts — Calculator paywall PDF report generator (E2)
 *
 * Generates a client-side PDF that summarises a user's Italy-vs-Switzerland
 * simulation. Uses jsPDF (already in the stack, lazy-imported to keep the
 * critical-path bundle lean) to produce:
 *   - Header with brand + site URL + generation date
 *   - Key metric table (netto IT, netto CH, differenza annua, carico fiscale %,
 *     contributi sociali)
 *   - Footer disclaimer
 *
 * Returns a Blob so callers can either email it (via the Cloud Function
 * `sendCalculatorReport`) or trigger a direct download.
 */

import type { SimulationResult, SimulationInputs } from '../types';

export interface CalculatorSimulationSnapshot {
  result: SimulationResult;
  inputs: SimulationInputs;
  locale?: string;
  generatedAt?: Date;
}

const BRAND_URL = 'https://frontaliereticino.ch';
const BRAND_NAME = 'Frontaliere Ticino';
const DISCLAIMER =
  'Report generato automaticamente a scopo informativo. I valori sono stime basate sui dati forniti e non costituiscono consulenza fiscale.';

const safeNumber = (value: number | undefined | null, fallback = 0): number => {
  if (value === null || value === undefined) return fallback;
  if (!Number.isFinite(value)) return fallback;
  return value;
};

const formatCHF = (value: number): string =>
  `CHF ${Math.round(Math.abs(safeNumber(value))).toLocaleString('it-IT')}`;

const formatEUR = (value: number): string =>
  `€ ${Math.round(Math.abs(safeNumber(value))).toLocaleString('it-IT')}`;

const formatPercent = (value: number): string => `${safeNumber(value).toFixed(1)}%`;

/**
 * Compute effective tax burden as a share of gross income.
 * Returns 0 when gross income is missing/zero (defensive default).
 */
function computeTaxBurdenPct(gross: number, taxes: number, social: number): number {
  const g = safeNumber(gross);
  if (g <= 0) return 0;
  const denominator = Math.abs(g);
  const burden = (Math.abs(safeNumber(taxes)) + Math.abs(safeNumber(social))) / denominator;
  return burden * 100;
}

export interface CalculatorPdfMetrics {
  netIT_EUR: number;
  netCH_CHF: number;
  diffAnnuaCHF: number;
  taxBurdenITPct: number;
  taxBurdenCHPct: number;
  socialIT_EUR: number;
  socialCH_CHF: number;
}

export function computeCalculatorPdfMetrics(snapshot: CalculatorSimulationSnapshot): CalculatorPdfMetrics {
  const { result } = snapshot;
  const ch = result?.chResident;
  const it = result?.itResident;
  const exchangeRate = safeNumber(result?.exchangeRate, 1);

  const netCH_CHF = safeNumber(ch?.netIncomeAnnual);
  // itResident amounts are stored in CHF (see TaxBreakdownItem usage in ResultsView).
  // The UI converts to EUR via exchangeRate for display.
  const netIT_EUR = Math.round(safeNumber(it?.netIncomeAnnual) * exchangeRate);
  const socialCH_CHF = Math.abs(safeNumber(ch?.socialContributions));
  const socialIT_EUR = Math.round(Math.abs(safeNumber(it?.socialContributions)) * exchangeRate);
  const diffAnnuaCHF = safeNumber(result?.savingsCHF);

  const taxBurdenCHPct = computeTaxBurdenPct(
    safeNumber(ch?.grossIncome),
    safeNumber(ch?.taxes),
    safeNumber(ch?.socialContributions),
  );
  const taxBurdenITPct = computeTaxBurdenPct(
    safeNumber(it?.grossIncome),
    safeNumber(it?.taxes),
    safeNumber(it?.socialContributions),
  );

  return {
    netIT_EUR,
    netCH_CHF,
    diffAnnuaCHF,
    taxBurdenITPct,
    taxBurdenCHPct,
    socialIT_EUR,
    socialCH_CHF,
  };
}

/**
 * Generate a Blob containing the calculator PDF report.
 * Uses jsPDF (lazy-imported). The email parameter is embedded in the footer
 * so the recipient knows which address it was sent to.
 */
export async function generateCalculatorPdfReport(
  snapshot: CalculatorSimulationSnapshot,
  email: string,
): Promise<Blob> {
  const { jsPDF } = await import('jspdf');
  const autoTableMod = await import('jspdf-autotable');
  const autoTable = autoTableMod.default;

  const doc = new jsPDF();
  const metrics = computeCalculatorPdfMetrics(snapshot);
  const generatedAt = snapshot.generatedAt ?? new Date();

  // Header band
  doc.setFillColor(30, 41, 59);
  doc.rect(0, 0, 210, 32, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(18);
  doc.setFont('helvetica', 'bold');
  doc.text(BRAND_NAME, 14, 14);
  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(203, 213, 225);
  doc.text(BRAND_URL, 14, 21);
  doc.text(`Generato: ${generatedAt.toLocaleDateString('it-IT')}`, 14, 27);

  // Title
  doc.setTextColor(15, 23, 42);
  doc.setFontSize(16);
  doc.setFont('helvetica', 'bold');
  doc.text('Il tuo confronto Italia-Svizzera', 14, 46);

  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(71, 85, 105);
  doc.text(`Inviato a: ${email}`, 14, 52);

  // Metric table
  const body = [
    ['Netto annuo (residente Italia)', formatEUR(metrics.netIT_EUR)],
    ['Netto annuo (residente Svizzera)', formatCHF(metrics.netCH_CHF)],
    ['Differenza annua', formatCHF(metrics.diffAnnuaCHF)],
    ['Carico fiscale Italia', formatPercent(metrics.taxBurdenITPct)],
    ['Carico fiscale Svizzera', formatPercent(metrics.taxBurdenCHPct)],
    ['Contributi sociali Italia', formatEUR(metrics.socialIT_EUR)],
    ['Contributi sociali Svizzera', formatCHF(metrics.socialCH_CHF)],
  ];

  autoTable(doc, {
    startY: 60,
    head: [['Indicatore', 'Valore']],
    body,
    theme: 'grid',
    headStyles: {
      fillColor: [37, 99, 235],
      fontSize: 11,
      fontStyle: 'bold',
    },
    columnStyles: {
      0: { cellWidth: 110, fontStyle: 'bold', textColor: [30, 41, 59] },
      1: { halign: 'right', textColor: [30, 64, 175] },
    },
    styles: {
      fontSize: 10,
      cellPadding: 5,
    },
  });

  // Footer disclaimer
  doc.setFontSize(9);
  doc.setTextColor(100, 116, 139);
  doc.text(DISCLAIMER, 14, 280, { maxWidth: 180 });

  return doc.output('blob');
}
