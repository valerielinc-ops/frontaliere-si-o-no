// Loaded with `node -r` by local-runner.mjs, only when Playwright has no Chromium build for this OS
// (Playwright 1.63 ships none for macOS 13): every Chromium launch of the agent uses the Chrome named by
// ASSISTED_APPLICATION_CHROME_PATH instead. Nothing else of the launch options changes.
const path = require('node:path');
const { createRequire } = require('node:module');

const executablePath = process.env.ASSISTED_APPLICATION_CHROME_PATH;
if (executablePath) {
  // The agent runs from the site checkout: resolve the same playwright the agent imports.
  const requireFromCheckout = createRequire(path.join(process.cwd(), 'package.json'));
  const { chromium } = requireFromCheckout('playwright');
  for (const name of ['launch', 'launchPersistentContext']) {
    const original = chromium[name].bind(chromium);
    chromium[name] = (...args) => {
      const index = name === 'launch' ? 0 : 1;
      args[index] = { ...(args[index] || {}), executablePath };
      return original(...args);
    };
  }
}
