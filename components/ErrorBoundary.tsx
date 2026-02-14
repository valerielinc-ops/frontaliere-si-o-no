import React, { Component, ErrorInfo, ReactNode } from 'react';
import { Analytics } from '../services/analytics';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { t } from '../services/i18n';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false
  };

  public static getDerivedStateFromError(_: Error): State {
    return { hasError: true };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Uncaught error:', error, errorInfo);
    // Send error to Google Analytics
    Analytics.trackError(`${error.name}: ${error.message}`, false);
  }

  public render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-[50vh] flex flex-col items-center justify-center p-6 text-center">
          <div className="bg-red-50 dark:bg-red-900/20 p-4 rounded-full mb-4">
             <AlertTriangle size={48} className="text-red-500" />
          </div>
          <h2 className="text-2xl font-bold text-slate-800 dark:text-slate-100 mb-2">{t('error.title')}</h2>
          <p className="text-slate-500 dark:text-slate-400 max-w-md mb-6">
            {t('error.message')}
          </p>
          <button
            onClick={() => window.location.reload()}
            className="flex items-center gap-2 px-6 py-3 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl font-bold transition-colors"
          >
            <RefreshCw size={18} /> {t('error.reload')}
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}