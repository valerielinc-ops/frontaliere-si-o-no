import { describe, it, expect } from 'vitest';
import { isBenignErrorMessage } from '@/services/benignErrorPatterns';

describe('isBenignErrorMessage()', () => {
  describe('drops confirmed-benign environmental noise', () => {
    it.each([
      // Carried over from the previous errorReporter NOISE_PATTERNS list
      'Failed to load Google Identity Services',
      'ResizeObserver loop completed with undelivered notifications.',
      'Script error.',
      'Error: Script error',
      'Failed to get document because the client is offline.',
      'TypeError: Importing a module script failed.',
      'Object Not Found Matching Id:3, MethodName:update, ParamCount:4',
      'Installations: Application offline (installations/app-offline).',
      'Connection to Indexed Database server lost. Refresh the page to try again',
      "Failed to execute 'transaction' on 'IDBDatabase': The database connection is closing.",
      'Database deleted by request of the user',
      'TypeError: Load failed',
      '[exchangeRate.twelveDataFetch] Failed to fetch',
      // ── New buckets (2026-06-22 triage) ──
      'TypeError: Failed to fetch',
      'Failed to fetch',
      'TypeError: NetworkError when attempting to fetch resource.',
      'NetworkError when attempting to fetch resource.',
      'AbortError: The user aborted a request.',
      'AbortError: The operation was aborted.',
      'AbortError: AbortError',
      "TypeError: undefined is not an object (evaluating 'window.__firefox__.reader')",
      "Can't find variable: __firefox__",
      "TypeError: undefined is not an object (evaluating 'window.ethereum.selectedAddress = undefined')",
      'i: Failed to connect to MetaMask',
      'TrackerStorageType is not defined',
      // Microsoft Clarity internal crash (#3760)
      "TypeError: undefined is not an object (evaluating 'n.standardSelectors')",
      "Cannot read properties of undefined (reading 'standardSelectors')",
      // Firebase Auth transient connectivity failure (#4174)
      'Firebase: Error (auth/network-request-failed).',
      '[auth.googleSignIn] Firebase: Error (auth/network-request-failed).',
    ])('drops: %s', (msg) => {
      expect(isBenignErrorMessage(msg)).toBe(true);
    });
  });

  describe('keeps real, actionable errors', () => {
    it.each([
      // Bare transport patterns are anchored — contextualized variants from
      // reportCaughtError (shaped `[context] …`) MUST still report.
      '[exchangeRate.cfFetch] Failed to fetch',
      '[jobBoard.loadJobs.shards] Load failed',
      '[firebase.initRemoteConfig] NetworkError when attempting to fetch resource.',
      // Genuine app bugs
      "TypeError: Cannot read properties of undefined (reading 'trackCalculation')",
      'TypeError: Ze is not a constructor',
      'RangeError: Maximum call stack size exceeded.',
      'Failed to fetch dynamically imported module: https://cdn.frontaliereticino.ch/assets/App.js',
    ])('keeps: %s', (msg) => {
      expect(isBenignErrorMessage(msg)).toBe(false);
    });
  });
});
