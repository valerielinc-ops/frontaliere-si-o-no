import React, { useState, useMemo } from 'react';
import { Building2, CreditCard, Euro, TrendingDown, AlertCircle, CheckCircle2, XCircle } from 'lucide-react';
import { useTranslation } from '@/services/i18n';

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

function getBanks(t: (key: string) => string): Bank[] {
  return [
    {
      name: 'PostFinance',
      country: 'CH',
      accountFee: 5,
      transactionFees: t('banks.postfinance.transactionFees'),
      atmFees: t('banks.postfinance.atmFees'),
      cardType: 'Maestro + Visa Debit',
      pros: [t('banks.postfinance.pro1'), t('banks.postfinance.pro2'), t('banks.postfinance.pro3')],
      cons: [t('banks.postfinance.con1'), t('banks.postfinance.con2'), t('banks.postfinance.con3')],
      color: 'from-yellow-500 to-orange-600',
      website: 'https://www.postfinance.ch',
      acceptsFrontalieri: true
    },
    {
      name: 'UBS',
      country: 'CH',
      accountFee: 0,
      transactionFees: t('banks.ubs.transactionFees'),
      atmFees: t('banks.ubs.atmFees'),
      cardType: 'Maestro + Visa Debit',
      pros: [t('banks.ubs.pro1'), t('banks.ubs.pro2'), t('banks.ubs.pro3')],
      cons: [t('banks.ubs.con1'), t('banks.ubs.con2'), t('banks.ubs.con3')],
      color: 'from-red-500 to-rose-600',
      website: 'https://www.ubs.com',
      acceptsFrontalieri: false
    },
    {
      name: 'Credit Suisse',
      country: 'CH',
      accountFee: 0,
      transactionFees: t('banks.creditSuisse.transactionFees'),
      atmFees: t('banks.creditSuisse.atmFees'),
      cardType: 'Maestro + Visa',
      pros: [t('banks.creditSuisse.pro1'), t('banks.creditSuisse.pro2')],
      cons: [t('banks.creditSuisse.con1'), t('banks.creditSuisse.con2'), t('banks.creditSuisse.con3')],
      color: 'from-blue-600 to-indigo-700',
      website: 'https://www.credit-suisse.com',
      acceptsFrontalieri: false
    },
    {
      name: 'Raiffeisen',
      country: 'CH',
      accountFee: 3,
      transactionFees: t('banks.raiffeisen.transactionFees'),
      atmFees: t('banks.raiffeisen.atmFees'),
      cardType: 'Maestro + Mastercard Debit',
      pros: [t('banks.raiffeisen.pro1'), t('banks.raiffeisen.pro2'), t('banks.raiffeisen.pro3')],
      cons: [t('banks.raiffeisen.con1'), t('banks.raiffeisen.con2'), t('banks.raiffeisen.con3')],
      color: 'from-green-600 to-emerald-700',
      website: 'https://www.raiffeisen.ch',
      acceptsFrontalieri: true
    },
    {
      name: 'Revolut',
      country: 'IT',
      accountFee: 0,
      transactionFees: t('banks.revolut.transactionFees'),
      atmFees: t('banks.revolut.atmFees'),
      cardType: 'Visa Debit (virtuale + fisica)',
      pros: [t('banks.revolut.pro1'), t('banks.revolut.pro2'), t('banks.revolut.pro3'), t('banks.revolut.pro4')],
      cons: [t('banks.revolut.con1'), t('banks.revolut.con2'), t('banks.revolut.con3')],
      color: 'from-purple-500 to-pink-600',
      website: 'https://www.revolut.com',
      acceptsFrontalieri: true
    },
    {
      name: 'Wise',
      country: 'IT',
      accountFee: 0,
      transactionFees: t('banks.wise.transactionFees'),
      atmFees: t('banks.wise.atmFees'),
      cardType: 'Visa Debit',
      pros: [t('banks.wise.pro1'), t('banks.wise.pro2'), t('banks.wise.pro3'), t('banks.wise.pro4')],
      cons: [t('banks.wise.con1'), t('banks.wise.con2'), t('banks.wise.con3')],
      color: 'from-emerald-500 to-teal-600',
      website: 'https://wise.com',
      acceptsFrontalieri: true
    },
    {
      name: 'Intesa Sanpaolo',
      country: 'IT',
      accountFee: 0,
      transactionFees: t('banks.intesa.transactionFees'),
      atmFees: t('banks.intesa.atmFees'),
      cardType: t('banks.intesa.cardType'),
      pros: [t('banks.intesa.pro1'), t('banks.intesa.pro2'), t('banks.intesa.pro3')],
      cons: [t('banks.intesa.con1'), t('banks.intesa.con2'), t('banks.intesa.con3')],
      color: 'from-blue-500 to-indigo-600',
      website: 'https://www.intesasanpaolo.com',
      acceptsFrontalieri: true
    },
    {
      name: 'Fineco',
      country: 'IT',
      accountFee: 0,
      transactionFees: t('banks.fineco.transactionFees'),
      atmFees: t('banks.fineco.atmFees'),
      cardType: t('banks.fineco.cardType'),
      pros: [t('banks.fineco.pro1'), t('banks.fineco.pro2'), t('banks.fineco.pro3'), t('banks.fineco.pro4')],
      cons: [t('banks.fineco.con1'), t('banks.fineco.con2'), t('banks.fineco.con3')],
      color: 'from-cyan-500 to-blue-600',
      website: 'https://www.fineco.it',
      acceptsFrontalieri: true
    },
    {
      name: 'Yuh',
      country: 'CH',
      accountFee: 0,
      transactionFees: t('banks.yuh.transactionFees'),
      atmFees: t('banks.yuh.atmFees'),
      cardType: 'Mastercard Debit',
      pros: [t('banks.yuh.pro1'), t('banks.yuh.pro2'), t('banks.yuh.pro3'), t('banks.yuh.pro4')],
      cons: [t('banks.yuh.con1'), t('banks.yuh.con2'), t('banks.yuh.con3')],
      color: 'from-violet-500 to-purple-600',
      website: 'https://www.yuh.com',
      acceptsFrontalieri: true
    },
    {
      name: 'Neon',
      country: 'CH',
      accountFee: 0,
      transactionFees: t('banks.neon.transactionFees'),
      atmFees: t('banks.neon.atmFees'),
      cardType: 'Mastercard Debit',
      pros: [t('banks.neon.pro1'), t('banks.neon.pro2'), t('banks.neon.pro3')],
      cons: [t('banks.neon.con1'), t('banks.neon.con2'), t('banks.neon.con3')],
      color: 'from-green-400 to-emerald-600',
      website: 'https://www.neon-free.ch',
      acceptsFrontalieri: true
    },
    {
      name: 'N26',
      country: 'IT',
      accountFee: 0,
      transactionFees: t('banks.n26.transactionFees'),
      atmFees: t('banks.n26.atmFees'),
      cardType: 'Mastercard Debit (virtuale + fisica)',
      pros: [t('banks.n26.pro1'), t('banks.n26.pro2'), t('banks.n26.pro3')],
      cons: [t('banks.n26.con1'), t('banks.n26.con2'), t('banks.n26.con3')],
      color: 'from-teal-500 to-cyan-600',
      website: 'https://n26.com',
      acceptsFrontalieri: true
    },
    {
      name: 'HYPE',
      country: 'IT',
      accountFee: 0,
      transactionFees: t('banks.hype.transactionFees'),
      atmFees: t('banks.hype.atmFees'),
      cardType: 'Visa Debit',
      pros: [t('banks.hype.pro1'), t('banks.hype.pro2'), t('banks.hype.pro3')],
      cons: [t('banks.hype.con1'), t('banks.hype.con2'), t('banks.hype.con3')],
      color: 'from-indigo-500 to-blue-600',
      website: 'https://www.hype.it',
      acceptsFrontalieri: true
    }
  ];
}

const BankComparison: React.FC = () => {
  const { t } = useTranslation();
  const banks = useMemo(() => getBanks(t), [t]);
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
          <h2 className="text-3xl font-extrabold">{t('banks.title')}</h2>
        </div>
        <p className="text-indigo-100 text-lg">{t('banks.subtitle')}</p>
      </div>

      <div className="bg-amber-50 dark:bg-amber-950/30 border-l-4 border-amber-500 p-4 rounded-lg">
        <div className="flex items-start gap-3">
          <AlertCircle className="text-amber-600 flex-shrink-0 mt-0.5" size={20} />
          <div className="text-sm text-amber-900 dark:text-amber-200">
            <p className="font-bold mb-1">{t('banks.strategyTitle')}</p>
            <p dangerouslySetInnerHTML={{ __html: t('banks.strategyText') }} />
          </div>
        </div>
      </div>

      <div className="bg-white dark:bg-slate-800 rounded-xl p-4 border border-slate-200 dark:border-slate-700">
        <div className="flex flex-wrap gap-4 items-center">
          <div className="flex items-center gap-2">
            <label className="text-sm font-bold">{t('banks.country')}:</label>
            <div className="flex gap-2">
              {['all', 'CH', 'IT'].map(c => (
                <button
                  key={c}
                  onClick={() => setFilterCountry(c as any)}
                  className={`px-4 py-2 rounded-lg text-sm font-bold ${filterCountry === c ? 'bg-indigo-600 text-white' : 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300'}`}
                >
                  {c === 'all' ? t('banks.all') : c === 'CH' ? '🇨🇭 CH' : '🇮🇹 IT'}
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
            <span className="text-sm font-bold">{t('banks.onlyFrontalieri')}</span>
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
                  <CheckCircle2 size={14} /> {t('banks.acceptsFrontalieri')}
                </div>
              )}

              <div className="flex items-start justify-between gap-4 mb-4">
                <div className="flex items-center gap-3">
                  <div className={`p-3 bg-gradient-to-br ${bank.color} rounded-2xl text-white`}>
                    <Building2 size={24} />
                  </div>
                  <div>
                    <h3 className="text-xl font-bold text-slate-800 dark:text-slate-100">{bank.name}</h3>
                    <p className="text-sm text-slate-500 dark:text-slate-400">{bank.country === 'CH' ? `🇨🇭 ${t('banks.switzerland')}` : `🇮🇹 ${t('banks.italy')}`}</p>
                  </div>
                </div>

                <div className="text-right">
                  <div className="text-2xl font-extrabold text-slate-800 dark:text-slate-100">
                    {bank.accountFee === 0 ? t('banks.free') : `${bank.accountFee} ${bank.country === 'CH' ? 'CHF' : '€'}`}
                  </div>
                  <div className="text-xs text-slate-500">{t('banks.monthlyFee')}</div>
                </div>
              </div>

              <div className="space-y-2 mb-4">
                <div className="flex justify-between text-sm">
                  <span className="text-slate-600 dark:text-slate-400">{t('banks.transfers')}</span>
                  <span className="font-bold text-slate-800 dark:text-slate-100">{bank.transactionFees}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-slate-600 dark:text-slate-400">{t('banks.atmWithdrawals')}</span>
                  <span className="font-bold text-slate-800 dark:text-slate-100">{bank.atmFees}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-slate-600 dark:text-slate-400">{t('banks.card')}</span>
                  <span className="font-bold text-slate-800 dark:text-slate-100">{bank.cardType}</span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3 mb-4">
                <div className="p-3 bg-emerald-50 dark:bg-emerald-950/30 rounded-lg">
                  <p className="text-xs font-bold text-emerald-700 dark:text-emerald-400 mb-1">✓ {t('banks.pros')}</p>
                  <ul className="space-y-1">
                    {bank.pros.slice(0, 2).map((p, i) => (
                      <li key={i} className="text-xs text-slate-700 dark:text-slate-300">• {p}</li>
                    ))}
                  </ul>
                </div>
                <div className="p-3 bg-red-50 dark:bg-red-950/30 rounded-lg">
                  <p className="text-xs font-bold text-red-700 dark:text-red-400 mb-1">✗ {t('banks.cons')}</p>
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
