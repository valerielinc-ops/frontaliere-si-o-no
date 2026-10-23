import { CheckCircle2 } from 'lucide-react';
import { CopyButton } from '@/components/admin/ui/CopyButton';

export default function ConfirmationEmailPreview() {
  return (
    <div className="bg-surface rounded-xl border border-edge overflow-hidden">
      <div className="px-4 py-3 border-b border-edge flex items-center gap-2">
        <CheckCircle2 size={16} className="text-warning" />
        <span className="text-sm font-semibold text-strong">Double Opt-In — Anteprima Email di Conferma</span>
        <span className="ml-auto text-xs bg-warning-subtle text-warning px-2 py-0.5 rounded-full font-medium">DRY RUN</span>
      </div>
      <div className="p-4 space-y-3">
        <p className="text-xs text-subtle">
          Quando il sistema sarà attivo, i nuovi iscritti riceveranno questa email di conferma.
          L&apos;invio sarà gestito tramite GitHub Actions workflow dispatch.
          Per ora i subscriber vengono salvati con <code className="text-xs bg-surface-raised px-1 py-0.5 rounded">status: &apos;pending&apos;</code>.
        </p>
        <iframe
          srcDoc={`<!DOCTYPE html>
<html lang="it">
<head>
 <meta charset="UTF-8">
 <meta name="viewport" content="width=device-width, initial-scale=1.0">
 <title>Conferma la tua iscrizione alla newsletter – Frontaliere Ticino</title>
</head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
 <table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:32px 16px;">
 <tr><td align="center">
 <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;">
 <tr><td style="text-align:center;padding-bottom:24px;">
 <a href="https://frontaliereticino.ch" style="text-decoration:none;">
 <img src="https://frontaliereticino.ch/icons/icon-192x192.png" alt="Frontaliere Ticino" width="48" height="48" style="display:block;margin:0 auto 8px;border-radius:12px;" />
 <div style="font-size:22px;font-weight:800;color:#2563EB;">Frontaliere Ticino</div>
 <div style="font-size:12px;color:#6b7280;letter-spacing:.04em;">La guida per i lavoratori frontalieri</div>
 </a>
 </td></tr>
 <tr><td style="background:#ffffff;border:1px solid #dbe2ea;border-radius:16px;padding:32px 28px;">
 <div style="font-size:28px;font-weight:800;color:#0f172a;padding-bottom:8px;">Conferma la tua iscrizione ✉️</div>
 <div style="font-size:15px;line-height:1.6;color:#1f2937;padding-bottom:20px;">
 Grazie per esserti iscritto alla newsletter di <strong>Frontaliere Ticino</strong>! Per attivare la tua iscrizione e ricevere aggiornamenti settimanali su tasso di cambio, offerte di lavoro, novità fiscali e guide pratiche, conferma cliccando il pulsante qui sotto.
 </div>
 <table width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0;">
 <tr><td align="center">
 <a href="#" style="display:inline-block;background:#2563EB;color:#ffffff;text-decoration:none;padding:16px 32px;border-radius:12px;font-size:16px;font-weight:700;letter-spacing:.02em;">
 Conferma iscrizione
 </a>
 </td></tr>
 </table>
 <div style="font-size:13px;color:#6b7280;padding-bottom:10px;">
 Oppure copia e incolla questo link nel browser:
 </div>
 <div style="background:#f8fafc;border:1px solid #dbe2ea;border-radius:8px;padding:12px;font-size:12px;color:#6b7280;word-break:break-all;">
 https://frontaliereticino.ch/?action=confirm_newsletter&amp;email=esempio@email.com&amp;token=abc123
 </div>
 <div style="border-top:1px solid #dbe2ea;margin:24px 0;"></div>
 <div style="font-size:14px;color:#1f2937;line-height:1.6;">
 <strong>Cosa riceverai ogni settimana:</strong>
 <ul style="padding-left:20px;margin:10px 0;">
 <li>📊 Tasso di cambio CHF-EUR aggiornato</li>
 <li>💼 Nuove offerte di lavoro in Ticino</li>
 <li>📋 Aggiornamenti fiscali e normativi</li>
 <li>📖 Guide pratiche per frontalieri</li>
 </ul>
 </div>
 <div style="border-top:1px solid #dbe2ea;margin:24px 0;"></div>
 <div style="font-size:13px;color:#6b7280;line-height:1.6;">
 <strong>Non ti sei iscritto?</strong> Ignora questa email in tutta sicurezza. Il link è valido per 7 giorni.
 </div>
 </td></tr>
 <tr><td style="text-align:center;padding:20px 0 8px;">
 <div style="font-size:12px;color:#6b7280;">
 © ${new Date().getFullYear()} Frontaliere Ticino ·
 <a href="https://frontaliereticino.ch" style="color:#6b7280;text-decoration:none;">frontaliereticino.ch</a>
 </div>
 </td></tr>
 </table>
 </td></tr>
 </table>
</body>
</html>`}
          title="Confirmation email preview"
          className="w-full border border-edge rounded-lg h-[720px]"
          sandbox="allow-same-origin"
        />
        <div className="bg-surface-alt rounded-lg p-3 space-y-2">
          <h4 className="text-xs font-semibold text-body">Workflow dispatch (quando attivo):</h4>
          <CopyButton text="gh workflow run send-confirmation-email.yml -f email=subscriber@example.com -f token=UUID" label="Workflow dispatch" />
          <p className="text-sm text-muted">
            Il workflow legge i subscriber con <code className="bg-surface-raised px-1 py-0.5 rounded text-xs">status: &apos;pending&apos;</code> da Firestore,
            genera un link di conferma con token, e invia via Resend.
            Al click del link, una Cloud Function aggiorna <code className="bg-surface-raised px-1 py-0.5 rounded text-xs">status: &apos;confirmed&apos;</code> e <code className="bg-surface-raised px-1 py-0.5 rounded text-xs">isActive: true</code>.
          </p>
        </div>
      </div>
    </div>
  );
}
