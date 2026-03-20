import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..');

describe('Google GIS surfaces', () => {
  it('uses readiness-based GIS rendering on the main gated Google sign-in surfaces', () => {
    const popupSource = readFileSync(resolve(root, 'components/community/NewsletterPopup.tsx'), 'utf8');
    const newsletterSource = readFileSync(resolve(root, 'components/community/Newsletter.tsx'), 'utf8');
    const taxCalendarSource = readFileSync(resolve(root, 'components/fisco/TaxCalendar.tsx'), 'utf8');
    const chatbotSource = readFileSync(resolve(root, 'components/shared/AiChatbot.tsx'), 'utf8');
    const appSource = readFileSync(resolve(root, 'App.tsx'), 'utf8');

    expect(popupSource).toContain('renderGoogleButtonWithReadiness');
    expect(popupSource).toContain('const [googleButtonReady, setGoogleButtonReady] = useState(false);');
    expect(newsletterSource).toContain('renderGoogleButtonWithReadiness');
    expect(newsletterSource).toContain('const [googleButtonReady, setGoogleButtonReady] = useState(false);');
    expect(taxCalendarSource).toContain('renderGoogleButtonWithReadiness');
    expect(taxCalendarSource).toContain('const [reminderGoogleButtonReady, setReminderGoogleButtonReady] = useState<boolean>(false);');
    expect(taxCalendarSource).toContain("Analytics.trackUIInteraction('tax_calendar', 'checklist_reminder_funnel', 'method', 'google_gis_resume');");
    expect(taxCalendarSource).not.toContain('export default TaxCalendar;\n  useEffect');
    expect(chatbotSource).toContain('renderGoogleButtonWithReadiness');
    expect(chatbotSource).toContain('const [googleButtonReady, setGoogleButtonReady] = useState(false);');
    expect(appSource).toContain('renderGoogleButtonWithReadiness');
    expect(appSource).toContain('const [adminGoogleButtonReady, setAdminGoogleButtonReady] = useState(false);');
  });
});
