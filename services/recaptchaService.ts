/**
 * reCAPTCHA Enterprise Service
 * Protegge le API a consumo da abusi e bot
 */

// Estendi il tipo Window per includere grecaptcha
declare global {
  interface Window {
    grecaptcha?: {
      enterprise: {
        ready: (callback: () => void) => void;
        execute: (siteKey: string, options: { action: string }) => Promise<string>;
      };
    };
  }
}

export type RecaptchaAction = 
  | 'TRAFFIC_DATA'      // Richiesta dati traffico Google Maps
  | 'EXCHANGE_RATES'    // Richiesta tassi di cambio
  | 'FEEDBACK_SUBMIT'   // Invio feedback
  | 'API_TEST'          // Test API
  | 'PAGE_LOAD';        // Caricamento pagina

class RecaptchaService {
  private siteKey: string | null = null;
  private isReady: boolean = false;

  constructor() {
    // Site key loaded dynamically from Firebase Remote Config, not from env
    this.siteKey = null;
    
    // Attendi che reCAPTCHA sia pronto
    if (this.isEnabled() && typeof window !== 'undefined') {
      this.waitForRecaptcha();
    }
  }

  /**
   * Controlla se reCAPTCHA è configurato
   */
  public isEnabled(): boolean {
    return this.siteKey !== null && this.siteKey.length > 0;
  }

  /**
   * Attende che lo script reCAPTCHA sia caricato
   */
  private async waitForRecaptcha(): Promise<void> {
    return new Promise((resolve) => {
      const checkRecaptcha = () => {
        if (window.grecaptcha?.enterprise) {
          window.grecaptcha.enterprise.ready(() => {
            this.isReady = true;
            resolve();
          });
        } else {
          // Riprova dopo 100ms
          setTimeout(checkRecaptcha, 100);
        }
      };
      checkRecaptcha();
    });
  }

  /**
   * Esegue la verifica reCAPTCHA e restituisce il token
   * @param action L'azione da verificare (es. 'TRAFFIC_DATA', 'EXCHANGE_RATES')
   * @returns Token reCAPTCHA o null se non disponibile
   */
  public async executeRecaptcha(action: RecaptchaAction): Promise<string | null> {
    // Se reCAPTCHA non è configurato, restituisci null (modalità fallback)
    if (!this.isEnabled()) {
      console.warn('reCAPTCHA non configurato - operazione consentita senza verifica');
      return null;
    }

    try {
      // Attendi che reCAPTCHA sia pronto se non lo è ancora
      if (!this.isReady) {
        await this.waitForRecaptcha();
      }

      // Esegui la verifica
      if (window.grecaptcha?.enterprise && this.siteKey) {
        const token = await window.grecaptcha.enterprise.execute(this.siteKey, {
          action: action
        });
        
        console.log(`✅ reCAPTCHA token ottenuto per azione: ${action}`);
        return token;
      }

      console.warn('reCAPTCHA non disponibile');
      return null;

    } catch (error) {
      console.error('Errore durante l\'esecuzione di reCAPTCHA:', error);
      // In caso di errore, permetti comunque l'operazione (graceful degradation)
      return null;
    }
  }

  /**
   * Verifica se una richiesta può procedere (con o senza token)
   * Questa funzione può essere estesa per implementare logiche di throttling
   */
  public async canProceed(action: RecaptchaAction): Promise<boolean> {
    // Se reCAPTCHA è abilitato, richiedi il token
    if (this.isEnabled()) {
      const token = await this.executeRecaptcha(action);
      // Anche se il token fallisce, permetti l'operazione (graceful degradation)
      return true;
    }
    
    // Se reCAPTCHA non è configurato, permetti sempre
    return true;
  }

  /**
   * Ottiene il token reCAPTCHA per una richiesta API
   * Da inviare al backend per la verifica
   */
  public async getTokenForApi(action: RecaptchaAction): Promise<string | null> {
    return await this.executeRecaptcha(action);
  }
}

// Esporta un'istanza singleton
export const recaptchaService = new RecaptchaService();
export default recaptchaService;
