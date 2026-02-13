/**
 * Server-side reCAPTCHA Enterprise Assessment Verification
 * 
 * Questo file contiene il codice Node.js per verificare i token reCAPTCHA
 * lato server usando l'API reCAPTCHA Enterprise Assessment.
 * 
 * IMPORTANTE: Questo codice deve essere eseguito SOLO su un server backend,
 * mai nel browser (la secret key non deve mai essere esposta al client).
 * 
 * Setup:
 * 1. npm install @google-cloud/recaptcha-enterprise
 * 2. Configura le credenziali Google Cloud:
 *    - gcloud auth application-default login
 *    - oppure imposta GOOGLE_APPLICATION_CREDENTIALS
 * 3. Integra questo codice nel tuo backend API
 */

const {RecaptchaEnterpriseServiceClient} = require('@google-cloud/recaptcha-enterprise');

/**
 * Crea una valutazione per analizzare il rischio di un'azione della UI.
 *
 * @param {string} projectID - L'ID del tuo progetto Google Cloud
 * @param {string} recaptchaKey - La chiave reCAPTCHA associata al sito o all'app
 * @param {string} token - Il token generato ottenuto dal client
 * @param {string} recaptchaAction - Nome dell'azione corrispondente al token
 * @returns {Promise<number|null>} - Il punteggio di rischio (0.0-1.0) o null se non valido
 */
async function createAssessment({
  projectID = "frontaliere-ticino",
  recaptchaKey = "6LcvRmosAAAAANg2upkWsseTFrN6eO5erywetm59",
  token,
  recaptchaAction,
}) {
  // Crea il client reCAPTCHA.
  // BEST PRACTICE: memorizza nella cache il client (consigliato) o chiama client.close() prima di uscire
  const client = new RecaptchaEnterpriseServiceClient();
  const projectPath = client.projectPath(projectID);

  // Crea la richiesta di assessment
  const request = {
    assessment: {
      event: {
        token: token,
        siteKey: recaptchaKey,
      },
    },
    parent: projectPath,
  };

  try {
    const [response] = await client.createAssessment(request);

    // Verifica che il token sia valido
    if (!response.tokenProperties.valid) {
      console.log(`❌ Token non valido: ${response.tokenProperties.invalidReason}`);
      return null;
    }

    // Controlla se è stata eseguita l'azione prevista
    if (response.tokenProperties.action === recaptchaAction) {
      // Ottieni il punteggio di rischio e i motivi
      const score = response.riskAnalysis.score;
      console.log(`✅ reCAPTCHA score: ${score}`);
      
      if (response.riskAnalysis.reasons && response.riskAnalysis.reasons.length > 0) {
        console.log('Reasons:');
        response.riskAnalysis.reasons.forEach((reason) => {
          console.log(`  - ${reason}`);
        });
      }

      return score;
    } else {
      console.log(`❌ Action mismatch: expected "${recaptchaAction}", got "${response.tokenProperties.action}"`);
      return null;
    }
  } catch (error) {
    console.error('❌ Errore durante la verifica reCAPTCHA:', error);
    return null;
  }
}

/**
 * Middleware Express per verificare reCAPTCHA
 * 
 * Esempio di utilizzo:
 * app.post('/api/protected-endpoint', verifyRecaptcha, async (req, res) => {
 *   // Il token è stato verificato, procedi con la logica
 *   res.json({ success: true });
 * });
 */
async function verifyRecaptcha(req, res, next) {
  const token = req.body.recaptchaToken || req.headers['x-recaptcha-token'];
  const expectedAction = req.body.action || 'unknown';

  if (!token) {
    return res.status(400).json({ 
      error: 'reCAPTCHA token mancante' 
    });
  }

  try {
    const score = await createAssessment({
      projectID: process.env.GOOGLE_CLOUD_PROJECT_ID || 'frontaliere-ticino',
      recaptchaKey: process.env.RECAPTCHA_SITE_KEY || '6LcvRmosAAAAANg2upkWsseTFrN6eO5erywetm59',
      token: token,
      recaptchaAction: expectedAction,
    });

    if (score === null) {
      return res.status(403).json({ 
        error: 'Verifica reCAPTCHA fallita' 
      });
    }

    // Soglia di score: 0.5 è un buon valore di default
    // Valori più alti = più rigido, meno falsi positivi ma più falsi negativi
    const SCORE_THRESHOLD = 0.5;

    if (score < SCORE_THRESHOLD) {
      console.log(`⚠️ Score troppo basso: ${score} < ${SCORE_THRESHOLD}`);
      return res.status(403).json({ 
        error: 'Score reCAPTCHA troppo basso',
        score: score 
      });
    }

    // Aggiungi score alla request per uso successivo
    req.recaptchaScore = score;
    next();
  } catch (error) {
    console.error('Errore verifica reCAPTCHA:', error);
    return res.status(500).json({ 
      error: 'Errore interno durante verifica reCAPTCHA' 
    });
  }
}

/**
 * Esempio di endpoint API protetto
 */
function exampleExpressApp() {
  const express = require('express');
  const app = express();
  
  app.use(express.json());

  // Endpoint per dati traffico (protetto da reCAPTCHA)
  app.post('/api/traffic-data', verifyRecaptcha, async (req, res) => {
    console.log(`✅ Richiesta traffico verificata con score: ${req.recaptchaScore}`);
    
    // Qui puoi chiamare Google Maps API senza preoccuparti di bot
    // const trafficData = await fetchGoogleMapsTraffic();
    
    res.json({ 
      success: true,
      message: 'Dati traffico recuperati',
      score: req.recaptchaScore 
    });
  });

  // Endpoint per feedback GitHub (protetto da reCAPTCHA)
  app.post('/api/feedback', verifyRecaptcha, async (req, res) => {
    console.log(`✅ Feedback verificato con score: ${req.recaptchaScore}`);
    
    // Qui puoi creare issue su GitHub senza spam
    // const issue = await createGitHubIssue(req.body);
    
    res.json({ 
      success: true,
      message: 'Feedback inviato',
      score: req.recaptchaScore 
    });
  });

  return app;
}

// Export per uso in altri moduli
module.exports = {
  createAssessment,
  verifyRecaptcha,
  exampleExpressApp
};

/**
 * INTERPRETAZIONE DELLO SCORE:
 * 
 * 1.0 - 0.9: Molto probabilmente umano legittimo
 * 0.9 - 0.7: Probabilmente umano
 * 0.7 - 0.5: Incerto, potrebbe essere bot semplice
 * 0.5 - 0.3: Probabilmente bot
 * 0.3 - 0.0: Quasi certamente bot
 * 
 * SOGLIE CONSIGLIATE PER AZIONE:
 * 
 * - Login: 0.5
 * - Registrazione: 0.7
 * - Payment: 0.8
 * - API ad alto costo (Google Maps): 0.6
 * - Feedback/Contact form: 0.5
 * - Page view: 0.3
 */

/**
 * SETUP GOOGLE CLOUD:
 * 
 * 1. Console Google Cloud → IAM & Admin → Service Accounts
 * 2. Crea Service Account: "recaptcha-verifier"
 * 3. Assegna ruolo: "reCAPTCHA Enterprise Agent"
 * 4. Crea chiave JSON e scarica
 * 5. Imposta variabile d'ambiente:
 *    export GOOGLE_APPLICATION_CREDENTIALS="/path/to/service-account-key.json"
 * 
 * Oppure usa gcloud CLI:
 *    gcloud auth application-default login
 */

/**
 * ENVIRONMENT VARIABLES:
 * 
 * GOOGLE_CLOUD_PROJECT_ID=frontaliere-ticino
 * RECAPTCHA_SITE_KEY=6LcvRmosAAAAANg2upkWsseTFrN6eO5erywetm59
 * RECAPTCHA_SECRET_KEY=6LcvRmosAAAAADYMc8QueYvyxDh-X0FN307JGK_G
 * GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account-key.json
 */
