import React from 'react';
import { Trash2, Shield, CheckCircle2 } from 'lucide-react';

/**
 * Data Deletion Callback Page for Facebook App
 * This page is required by Facebook for apps that use Facebook Login
 * URL: https://frontalieresiono.com/data-deletion
 */

export const DataDeletion: React.FC = () => {
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-slate-50 dark:from-slate-950 dark:via-slate-900 dark:to-slate-950 flex items-center justify-center px-4 py-12">
      <div className="max-w-2xl w-full">
        
        {/* Header */}
        <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-8 shadow-xl mb-6">
          <div className="flex items-center gap-4 mb-6">
            <div className="p-3 bg-gradient-to-br from-red-500 to-pink-600 rounded-2xl shadow-lg">
              <Trash2 className="text-white" size={32} />
            </div>
            <div>
              <h1 className="text-3xl font-extrabold text-slate-800 dark:text-slate-100">Data Deletion</h1>
              <p className="text-sm text-slate-500 dark:text-slate-500 mt-1">Facebook App Data Deletion Callback</p>
            </div>
          </div>
        </div>

        {/* Main Content */}
        <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-8 shadow-lg space-y-6">
          
          {/* No Data Collected Message */}
          <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-xl p-6">
            <div className="flex items-start gap-3">
              <CheckCircle2 className="text-green-600 dark:text-green-400 flex-shrink-0 mt-1" size={24} />
              <div>
                <h2 className="text-lg font-bold text-green-800 dark:text-green-300 mb-2">
                  No Data to Delete
                </h2>
                <p className="text-sm text-green-700 dark:text-green-400 leading-relaxed">
                  Our application <strong>"Frontaliere Si o No?"</strong> does <strong>not collect, store, or process</strong> any personal data from Facebook users or any other users.
                </p>
              </div>
            </div>
          </div>

          {/* Explanation */}
          <div className="space-y-4 text-slate-600 dark:text-slate-500">
            <div className="flex items-start gap-3">
              <Shield className="text-indigo-500 flex-shrink-0 mt-1" size={20} />
              <div>
                <h3 className="font-bold text-slate-800 dark:text-slate-100 mb-1">Client-Side Application</h3>
                <p className="text-sm">
                  All calculations and data processing happen entirely in your browser. No data is transmitted to our servers.
                </p>
              </div>
            </div>

            <div className="flex items-start gap-3">
              <Shield className="text-indigo-500 flex-shrink-0 mt-1" size={20} />
              <div>
                <h3 className="font-bold text-slate-800 dark:text-slate-100 mb-1">No User Database</h3>
                <p className="text-sm">
                  We do not maintain any database of user information, login credentials, or personal data.
                </p>
              </div>
            </div>

            <div className="flex items-start gap-3">
              <Shield className="text-indigo-500 flex-shrink-0 mt-1" size={20} />
              <div>
                <h3 className="font-bold text-slate-800 dark:text-slate-100 mb-1">No Facebook Login</h3>
                <p className="text-sm">
                  Our application does not require Facebook login or access to your Facebook data. We only maintain a Facebook page for community engagement.
                </p>
              </div>
            </div>
          </div>

          {/* Divider */}
          <div className="border-t border-slate-200 dark:border-slate-700"></div>

          {/* What We Do Collect */}
          <div>
            <h3 className="font-bold text-slate-800 dark:text-slate-100 mb-3">What We Do Collect:</h3>
            <ul className="space-y-2 text-sm text-slate-600 dark:text-slate-500">
              <li className="flex items-start gap-2">
                <span className="text-slate-500">•</span>
                <span><strong>Anonymous Analytics:</strong> Google Analytics collects anonymous usage statistics (page views, device type, browser). No personally identifiable information.</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-slate-500">•</span>
                <span><strong>Local Preferences:</strong> Theme preferences (dark/light mode) stored in your browser's local storage. Never leaves your device.</span>
              </li>
            </ul>
          </div>

          {/* Divider */}
          <div className="border-t border-slate-200 dark:border-slate-700"></div>

          {/* Data Deletion Request */}
          <div className="bg-slate-50 dark:bg-slate-900/50 rounded-xl p-6 border border-slate-200 dark:border-slate-700">
            <h3 className="font-bold text-slate-800 dark:text-slate-100 mb-3">Data Deletion Request</h3>
            <p className="text-sm text-slate-600 dark:text-slate-500 mb-4">
              Since we do not collect or store any user data, there is <strong>no data to delete</strong> from our systems.
            </p>
            <p className="text-sm text-slate-600 dark:text-slate-500">
              If you have concerns about data privacy, please refer to our <a href="/privacy" className="text-indigo-600 dark:text-indigo-400 hover:underline font-semibold">Privacy Policy</a> or contact us via our Facebook page.
            </p>
          </div>

          {/* Confirmation Code (for Facebook) */}
          <div className="bg-indigo-50 dark:bg-indigo-950/30 rounded-xl p-6 border border-indigo-200 dark:border-indigo-800">
            <h3 className="font-bold text-indigo-800 dark:text-indigo-300 mb-2">Confirmation</h3>
            <p className="text-sm text-indigo-700 dark:text-indigo-400">
              For Facebook App Review purposes: This page serves as the Data Deletion Callback URL as required by Facebook's Platform Policy.
            </p>
            <div className="mt-4 p-3 bg-white dark:bg-slate-800 rounded-lg border border-indigo-200 dark:border-indigo-700">
              <code className="text-xs text-slate-700 dark:text-slate-300 font-mono">
                Status: NO_DATA_COLLECTED<br/>
                Confirmation: No user data is stored or processed by this application.
              </code>
            </div>
          </div>

        </div>

        {/* Contact */}
        <div className="mt-6 text-center">
          <p className="text-sm text-slate-500 dark:text-slate-500">
            Questions? Contact us via{' '}
            <a 
              href="https://www.facebook.com/profile.php?id=61588174947294" 
              target="_blank" 
              rel="noopener noreferrer"
              className="text-indigo-600 dark:text-indigo-400 hover:underline font-semibold"
            >
              Facebook
            </a>
          </p>
          <p className="text-xs text-slate-500 dark:text-slate-500 mt-2">
            © 2026 Frontaliere Si o No? | <a href="/" className="hover:underline">Back to Home</a>
          </p>
        </div>

      </div>
    </div>
  );
};
