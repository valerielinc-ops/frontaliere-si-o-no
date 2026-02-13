import React, { useState } from 'react';
import { Building2, CreditCard, Euro, TrendingDown, AlertCircle, CheckCircle2, XCircle } from 'lucide-react';

interface Bank {
  name: string;
  country: 'CH' | 'IT';
  accountFee: number;
  transactionFees: string;
  atmFees: string;
  cardType: string;
  pros: string[];
  cons: string[];
  color: string;
  website: string;
  acceptsFrontalieri: boolean;
}

const banks: Bank[] = [
  {
    name: 'PostFinance',
    country: 'CH',
    accountFee: 5,
    transactionFees: 'Gratuiti in CH',
    atmFees: 'Gratuiti rete PostFinance',
    cardType: 'Maestro + Visa Debit',
    pros: ['Accetta frontalieri facilmente', 'App ottima', 'Rete ATM capillare'],
    cons: ['5 CHF/mese', 'Bonifici SEPA costosi (7.50 CHF)', 'Prelievi estero costosi'],
    color: 'from-yellow-500 to-orange-600',
    website: 'https://www.postfinance.ch',
    acceptsFrontalieri: true
  },
  {
    name: 'UBS',
    country: 'CH',
    accountFee: 0,
    transactionFees: 'Gratuiti se saldo >7500 CHF',
    atmFees: '2 CHF fuori rete UBS',
    cardType: 'Maestro + Visa Debit',
    pros: ['Gratis con saldo minimo', 'Banca solida', 'Servizi completi'],
    cons: ['Difficile apertura per frontalieri', 'Richiesto permesso G', 'Costi nascosti'],
    color: 'from-red-500 to-rose-600',
    website: 'https://www.ubs.com',
    acceptsFrontalieri: false
  },
  {
    name: 'Credit Suisse',
    country: 'CH',
    accountFee: 0,
    transactionFees: 'Variabili',
    atmFees: '2 CHF fuori rete',
    cardType: 'Maestro + Visa',
    pros: ['Nome prestigioso', 'Servizi banking avanzati'],
    cons: ['Raramente accetta frontalieri', 'Costi variabili', 'Burocrazia'],
    color: 'from-blue-600 to-indigo-700',
    website: 'https://www.credit-suisse.com',
    acceptsFrontalieri: false
  },
  {
    name: 'Raiffeisen',
    country: 'CH',
    accountFee: 3,
    transactionFees: 'Gratuiti in CH',
    atmFees: 'Gratuiti rete Raiffeisen',
    cardType: 'Maestro + Mastercard Debit',
    pros: ['Accetta frontalieri', 'Banca cooperativa', 'Costi contenuti'],
    cons: ['Dipende dalla filiale locale', 'App meno moderna', 'Rete ATM limitata'],
    color: 'from-green-600 to-emerald-700',
    website: 'https://www.raiffeisen.ch',
    acceptsFrontalieri: true
  },
  {
    name: 'Revolut',
    country: 'IT',
    accountFee: 0,
    transactionFees: 'Gratuiti',
    atmFees: '200€/mese gratis poi 2%',
    cardType: 'Visa Debit (virtuale + fisica)',
    pros: ['100% gratis base', 'Cambio CHF-EUR ottimo', 'App eccellente', 'Accetta tutti'],
    cons: ['Non IBAN CH', 'Non accettata ovunque', 'Supporto limitato'],
    color: 'from-purple-500 to-pink-600',
    website: 'https://www.revolut.com',
    acceptsFrontalieri: true
  },
  {
    name: 'Wise',
    country: 'IT',
    accountFee: 0,
    transactionFees: 'Gratuiti',
    atmFees: '200€/mese gratis poi 0.5%',
    cardType: 'Visa Debit',
    pros: ['Gratis', 'Cambio valuta reale', 'Multi-currency', 'IBAN UE'],
    cons: ['Non IBAN CH', 'Non per stipendio diretto', 'Solo online'],
    color: 'from-emerald-500 to-teal-600',
    website: 'https://wise.com',
    acceptsFrontalieri: true
  },
  {
    name: 'Intesa Sanpaolo',
    country: 'IT',
    accountFee: 0,
    transactionFees: 'Gratis con accredito stipendio',
    atmFees: 'Gratis rete Intesa',
    cardType: 'Bancomat + carta credito opzionale',
    pros: ['Gratis con stipendio', 'Banca solida', 'Filiali in Italia'],
    cons: ['Bonifici CH costosi', 'App datata', 'Cambio CHF sfavorevole'],
    color: 'from-blue-500 to-indigo-600',
    website: 'https://www.intesasanpaolo.com',
    acceptsFrontalieri: true
  },
  {
    name: 'Fineco',
    country: 'IT',
    accountFee: 0,
    transactionFees: 'Gratuiti',
    atmFees: 'Primi 100 prelievi gratis/anno',
    cardType: 'Debito + Credito inclusa',
    pros: ['Tutto gratuito', 'Trading incluso', 'App moderna', 'Zero canone'],
    cons: ['Cambio valuta con spread', 'IBAN IT', 'Supporto online'],
    color: 'from-cyan-500 to-blue-600',
    website: 'https://www.fineco.it',
    acceptsFrontalieri: true
  }
];

const BankComparison: React.FC = () => {
  const [filterCountry, setFilterCountry] = useState<'all' | 'CH' | 'IT'>('all');
  const [showOnlyFrontalieri, setShowOnlyFrontalieri] = useState<boolean>(true);

  const filtered = banks
    .filter(b => filterCountry === 'all' || b.country === filterCountry)
    .filter(b => !showOnlyFrontalieri || b.acceptsFrontalieri)
    .sort((a, b) => a.accountFee - b.accountFee);

  return (
    <div className="space-y-6 pb-8">
      <div className="bg-gradient-to-br from-indigo-600 to-purple-700 rounded-2xl p-8 text-white">
        <div className="flex items-center gap-3 mb-4">
          <Building2 size={32} />
          <h2 className="text-3xl font-extrabold">Banche per Frontalieri</h2>
        </div>
        <p className="text-indigo-100 text-lg">Confronta conti correnti CH e IT: costi, carte, bonifici</p>
      </div>

      <div className="bg-amber-50 dark:bg-amber-950/30 border-l-4 border-amber-500 p-4 rounded-lg">
        <div className="flex items-start gap-3">
          <AlertCircle className="text-amber-600 flex-shrink-0 mt-0.5" size={20} />
          <div className="text-sm text-amber-900 dark:text-amber-200">
            <p className="font-bold mb-1">💡 Strategia ideale frontalieri:</p>
            <p>
              <strong>1 conto CH</strong> (PostFinance/Raiffeisen) per stipendio + <strong>1 conto IT</strong> (Intesa/Fineco) per vita quotidiana + <strong>Revolut/Wise</strong> per cambio valuta
            </p>
          </div>
        </div>
      </div>

      <div className="bg-white dark:bg-slate-800 rounded-xl p-4 border border-slate-200 dark:border-slate-700">
        <div className="flex flex-wrap gap-4 items-center">
          <div className="flex items-center gap-2">
            <label className="text-sm font-bold">Paese:</label>
            <div className="flex gap-2">
              {['all', 'CH', 'IT'].map(c => (
                <button
                  key={c}
                  onClick={() => setFilterCountry(c as any)}
                  className={`px-4 py-2 rounded-lg text-sm font-bold ${filterCountry === c ? 'bg-indigo-600 text-white' : 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300'}`}
                >
                  {c === 'all' ? 'Tutti' : c === 'CH' ? '🇨🇭 CH' : '🇮🇹 IT'}
                </button>
              ))}
            </div>
          </div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={showOnlyFrontalieri}
              onChange={(e) => setShowOnlyFrontalieri(e.target.checked)}
              className="w-4 h-4"
            />
            <span className="text-sm font-bold">Solo banche che accettano frontalieri</span>
          </label>
        </div>
      </div>

      <div className="grid md:grid-cols-2 gap-6">
        {filtered.map((bank) => {
          const CardWrapper = bank.website ? 'a' : 'div';
          const cardProps = bank.website ? {
            href: bank.website,
            target: '_blank',
            rel: 'noopener noreferrer',
            className: `block bg-white dark:bg-slate-800 rounded-2xl border-2 p-6 hover:shadow-lg transition-all cursor-pointer ${bank.acceptsFrontalieri ? 'border-emerald-500 ring-2 ring-emerald-500/20' : 'border-slate-200 dark:border-slate-700'}`
          } : {
            className: `bg-white dark:bg-slate-800 rounded-2xl border-2 p-6 ${bank.acceptsFrontalieri ? 'border-emerald-500 ring-2 ring-emerald-500/20' : 'border-slate-200 dark:border-slate-700'}`
          };

          return (
            <CardWrapper key={bank.name} {...cardProps}>
              {bank.acceptsFrontalieri && (
                <div className="mb-3 inline-flex items-center gap-1.5 px-3 py-1.5 bg-emerald-500 text-white text-xs font-bold rounded-full">
                  <CheckCircle2 size={14} /> Accetta Frontalieri
                </div>
              )}

              <div className="flex items-start justify-between gap-4 mb-4">
                <div className="flex items-center gap-3">
                  <div className={`p-3 bg-gradient-to-br ${bank.color} rounded-2xl text-white`}>
                    <Building2 size={24} />
                  </div>
                  <div>
                    <h3 className="text-xl font-bold text-slate-800 dark:text-slate-100">{bank.name}</h3>
                    <p className="text-sm text-slate-500 dark:text-slate-400">{bank.country === 'CH' ? '🇨🇭 Svizzera' : '🇮🇹 Italia'}</p>
                  </div>
                </div>

                <div className="text-right">
                  <div className="text-2xl font-extrabold text-slate-800 dark:text-slate-100">
                    {bank.accountFee === 0 ? 'Gratis' : `${bank.accountFee} ${bank.country === 'CH' ? 'CHF' : '€'}`}
                  </div>
                  <div className="text-xs text-slate-500">canone mensile</div>
                </div>
              </div>

              <div className="space-y-2 mb-4">
                <div className="flex justify-between text-sm">
                  <span className="text-slate-600 dark:text-slate-400">Bonifici</span>
                  <span className="font-bold text-slate-800 dark:text-slate-100">{bank.transactionFees}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-slate-600 dark:text-slate-400">Prelievi ATM</span>
                  <span className="font-bold text-slate-800 dark:text-slate-100">{bank.atmFees}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-slate-600 dark:text-slate-400">Carta</span>
                  <span className="font-bold text-slate-800 dark:text-slate-100">{bank.cardType}</span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3 mb-4">
                <div className="p-3 bg-emerald-50 dark:bg-emerald-950/30 rounded-lg">
                  <p className="text-xs font-bold text-emerald-700 dark:text-emerald-400 mb-1">✓ Pro</p>
                  <ul className="space-y-1">
                    {bank.pros.slice(0, 2).map((p, i) => (
                      <li key={i} className="text-xs text-slate-700 dark:text-slate-300">• {p}</li>
                    ))}
                  </ul>
                </div>
                <div className="p-3 bg-red-50 dark:bg-red-950/30 rounded-lg">
                  <p className="text-xs font-bold text-red-700 dark:text-red-400 mb-1">✗ Contro</p>
                  <ul className="space-y-1">
                    {bank.cons.slice(0, 2).map((c, i) => (
                      <li key={i} className="text-xs text-slate-700 dark:text-slate-300">• {c}</li>
                    ))}
                  </ul>
                </div>
              </div>
            </CardWrapper>
          );
        })}
      </div>
    </div>
  );
};

export default BankComparison;
