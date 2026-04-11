import React from 'react';
import { Trash2, Shield, CheckCircle2 } from 'lucide-react';

/**
 * Data Deletion Callback Page for Facebook App
 * This page is required by Facebook for apps that use Facebook Login
 * URL: https://frontaliereticino.ch/data-deletion
 */

export const DataDeletion: React.FC = () => {
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-slate-50 dark:from-slate-950 dark:via-slate-900 dark:to-slate-950 flex items-center justify-center px-4 py-12">
      <div className="max-w-2xl w-full">
        
        {/* Header */}
        <div className="bg-surface rounded-2xl border border-edge p-5 sm:p-8 shadow-xl mb-6">
          <div className="flex items-center gap-4 mb-6">
            <div className="p-3 bg-gradient-to-br from-red-500 to-pink-600 rounded-2xl shadow-lg">
              <Trash2 className="text-white" size={32} />
            </div>
            <div>
              <h1 className="text-2xl sm:text-3xl font-extrabold text-slate-800 dark:text-slate-100">Data Deletion</h1>
              <p className="text-sm text-muted mt-1">Facebook App Data Deletion Callback</p>
            </div>
          </div>
        </div>

        {/* Main Content */}
        <div className="bg-surface rounded-2xl border border-edge p-5 sm:p-8 shadow-lg space-y-6">
          
          {/* No Data Collected Message */}
          <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-xl p-6">
            <div className="flex items-start gap-3">
              <CheckCircle2 className="text-green-600 dark:text-green-400 flex-shrink-0 mt-1" size={24} />
              <div>
                <h2 className="text-lg font-bold text-green-800 dark:text-green-300 mb-2">
                  No Data to Delete
                </h2>
                <p className="text-sm text-green-700 dark:text-green-400 leading-relaxed">
                  Our application <strong>"Frontaliere Ticino"</strong> does <strong>not collect, store, or process</strong> any personal data from Facebook users or any other users.
                </p>
              </div>
            </div>
          </div>

          {/* Explanation */}
          <div className="space-y-4 text-subtle">
            <div className="flex items-start gap-3">
              <Shield className="text-stripe-500 flex-shrink-0 mt-1" size={20} />
              <div>
                <h3 className="font-bold text-slate-800 dark:text-slate-100 mb-1">Client-Side Application</h3>
                <p className="text-sm">
                  All calculations and data processing happen entirely in your browser. No data is transmitted to our servers.
                </p>
              </div>
            </div>

            <div className="flex items-start gap-3">
              <Shield className="text-stripe-500 flex-shrink-0 mt-1" size={20} />
              <div>
                <h3 className="font-bold text-slate-800 dark:text-slate-100 mb-1">Facebook Login</h3>
                <p className="text-sm">
                  Our application uses Facebook Login for authentication only. We access your name and email address to create your account. We do not post to your timeline, access your friends list, or collect any other Facebook data.
                </p>
              </div>
            </div>

            <div className="flex items-start gap-3">
              <Shield className="text-stripe-500 flex-shrink-0 mt-1" size={20} />
              <div>
                <h3 className="font-bold text-slate-800 dark:text-slate-100 mb-1">How to Delete Your Data</h3>
                <p className="text-sm">
                  If you have an account, go to your <a href="/profilo-utente" className="text-stripe-600 dark:text-stripe-400 hover:underline font-semibold">Profile page</a> and use the "Delete Account" button. This will permanently remove your Firebase Auth account, Firestore profile data, newsletter subscription, and all associated data. You can also revoke access from your <a href="https://www.facebook.com/settings?tab=applications" target="_blank" rel="noopener noreferrer" className="text-stripe-600 dark:text-stripe-400 hover:underline font-semibold">Facebook App Settings</a>.
                </p>
              </div>
            </div>
          </div>

          {/* Divider */}
          <div className="border-t border-edge"></div>

          {/* What We Do Collect */}
          <div>
            <h3 className="font-bold text-slate-800 dark:text-slate-100 mb-3">What We Do Collect:</h3>
            <ul className="space-y-2 text-sm text-subtle">
              <li className="flex items-start gap-2">
                <span className="text-muted">•</span>
                <span><strong>Account Data (if signed in):</strong> Email address, display name, and profile photo from your Google or Facebook account, stored in Firebase Authentication and Firestore.</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-muted">•</span>
                <span><strong>Newsletter Subscription:</strong> Email address if you subscribe to our newsletter, stored in Firestore.</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-muted">•</span>
                <span><strong>Anonymous Analytics:</strong> Google Analytics collects anonymous usage statistics (page views, device type, browser). No personally identifiable information.</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-muted">•</span>
                <span><strong>Local Preferences:</strong> Theme preferences (dark/light mode) stored in your browser's local storage. Never leaves your device.</span>
              </li>
            </ul>
          </div>

          {/* Divider */}
          <div className="border-t border-edge"></div>

          {/* Data Deletion Request */}
          <div className="bg-surface-alt/50 rounded-xl p-4 sm:p-6 border border-edge">
            <h3 className="font-bold text-slate-800 dark:text-slate-100 mb-3">Data Deletion Request</h3>
            <p className="text-sm text-subtle mb-4">
              To delete all data associated with your account:
            </p>
            <ol className="text-sm text-subtle space-y-2 list-decimal list-inside mb-4">
              <li>Go to your <a href="/profilo-utente" className="text-stripe-600 dark:text-stripe-400 hover:underline font-semibold">Profile page</a></li>
              <li>Click the <strong>"Delete Account"</strong> button</li>
              <li>Confirm the deletion when prompted</li>
            </ol>
            <p className="text-sm text-subtle">
              This will permanently remove your Firebase Auth account, Firestore profile, newsletter subscription, and all associated data. You can also revoke app access from your <a href="https://www.facebook.com/settings?tab=applications" target="_blank" rel="noopener noreferrer" className="text-stripe-600 dark:text-stripe-400 hover:underline font-semibold">Facebook App Settings</a>.
            </p>
            <p className="text-sm text-subtle mt-3">
              For further questions, refer to our <a href="/privacy" className="text-stripe-600 dark:text-stripe-400 hover:underline font-semibold">Privacy Policy</a> or contact us via our Facebook page.
            </p>
          </div>

          {/* Confirmation Code (for Facebook) */}
          <div className="bg-stripe-50 dark:bg-stripe-950/30 rounded-xl p-4 sm:p-6 border border-stripe-200 dark:border-stripe-800">
            <h3 className="font-bold text-stripe-800 dark:text-stripe-300 mb-2">Confirmation</h3>
            <p className="text-sm text-stripe-700 dark:text-stripe-400">
              For Facebook App Review purposes: This page serves as the Data Deletion Callback URL as required by Facebook's Platform Policy.
            </p>
            <div className="mt-4 p-3 bg-surface rounded-lg border border-stripe-200 dark:border-stripe-700">
              <code className="text-xs text-body font-mono">
                Status: DATA_DELETABLE<br/>
                Method: Self-service via Profile page "Delete Account" button<br/>
                Scope: Firebase Auth profile, Firestore user data, newsletter subscription
              </code>
            </div>
          </div>

        </div>

        {/* Contact */}
        <div className="mt-6 text-center">
          <p className="text-sm text-muted">
            Questions? Contact us via{' '}
            <a 
              href="https://www.facebook.com/profile.php?id=61588174947294" 
              target="_blank" 
              rel="noopener noreferrer"
              className="text-stripe-600 dark:text-stripe-400 hover:underline font-semibold"
            >
              Facebook
            </a>
          </p>
          <p className="text-xs text-muted mt-2">
            © 2026 Frontaliere Ticino | <a href="/" className="hover:underline">Back to Home</a>
          </p>
        </div>

      </div>
    </div>
  );
};
