// functions/stripeconnectonboarding/index.js
// This file contains the Cloud Function for initiating Stripe Connect onboarding.

// --- REQUIRED MODULE IMPORTS FOR THIS FUNCTION ---
const functions = require('firebase-functions');
const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');
const stripe = require('stripe');

// --- Shared Stripe/Secret Manager Setup for this function ---
const secretManagerClient = new SecretManagerServiceClient();
let stripeInstance; // To store the initialized Stripe instance once retrieved

// Helper function to get Stripe Secret Key
async function getStripeSecretKey() {
    const projectId = process.env.GCP_PROJECT;
    if (!projectId) {
        throw new Error('GCP_PROJECT environment variable is not set. Cannot access Stripe secret key.');
    }
    const secretPath = `projects/${projectId}/secrets/stripe-secret-key/versions/latest`;

    console.log(`Attempting to access secret at: ${secretPath}`);

    try {
        const [version] = await secretManagerClient.accessSecretVersion({
            name: secretPath,
        });
        return version.payload.data.toString('utf8');
    } catch (error) {
        console.error(`Error accessing secret in getStripeSecretKey: ${error.message}`);
        throw new Error(`Failed to retrieve Stripe Secret Key: ${error.message}`);
    }
}


// --- stripeConnectOnboarding Function Definition ---
exports.stripeConnectOnboarding = functions.https.onRequest(async (req, res) => {
    console.log("--- stripeConnectOnboarding Function Called ---");
    console.log("Request Query Params:", req.query);
    console.log("Request Body:", req.body); 

    // Set CORS headers to allow requests from your Adalo app
    // IMPORTANT: Restrict 'Access-Control-Allow-Origin' to your Adalo domain in production for security
    res.set('Access-Control-Allow-Origin', 'https://admin.activetopia.socialtopiahq.com'); // Using your Adalo admin domain
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');

    // Handle preflight OPTIONS request
    if (req.method === 'OPTIONS') {
        res.status(204).send('');
        return;
    }

    try {
        // Define hardcoded Adalo redirect URLs for this white-labeled app
        // These should be the exact URLs of your success/failure screens in Adalo
        // NOTE: These must match the hardcoded URLs in stripeOAuthRedirect function
        const ADALO_SUCCESS_URL = 'https://admin.activetopia.socialtopiahq.com/activetopia-admin-dashboard?target=11909pzspdjskfsa7ubpukgup&params=%7B%7D';
        const ADALO_FAILURE_URL = 'https://admin.activetopia.socialtopiahq.com/activetopia-admin-dashboard?target=7s13zskf7e6tstip9ocx379h0&params=%7B%7D';


        // Extract adaloUserId from query parameters
        let adaloUserId = req.query.adaloUserId;

        // Parse adaloUserId if it's in Adalo's magic text string format (e.g., "{{70}}")
        if (adaloUserId) {
            const idMatchCurly = String(adaloUserId).match(/^\{\{(\d+)\}\}$/); // Matches {{ID}}
            const idMatchBracket = String(adaloUserId).match(/^\[\[(\d+):.*\]\]$/); // Matches [[ID: Display]]

            if (idMatchCurly && idMatchCurly[1]) {
                adaloUserId = idMatchCurly[1];
                console.log(`Parsed Adalo userId from query (curly braces): ${adaloUserId}`);
            } else if (idMatchBracket && idMatchBracket[1]) {
                adaloUserId = idMatchBracket[1];
                console.log(`Parsed Adalo userId from query (brackets): ${adaloUserId}`);
            } else {
                // Use as is if not in expected magic text format (e.g., already raw ID)
                console.warn(`WARNING: adaloUserId not in expected magic text format. Using as is: ${adaloUserId}`);
            }
        } else {
            console.error('Missing adaloUserId in request query parameters.');
            return res.status(400).send('Missing Adalo User ID in request.');
        }


        // Initialize Stripe instance if not already initialized
        if (!stripeInstance) {
            const stripeSecretKey = await getStripeSecretKey();
            stripeInstance = stripe(stripeSecretKey);
        }

        // Ensure your environment variables are correctly set for the Cloud Function.
        const clientId = process.env.STRIPE_CLIENT_ID;
        const redirectUri = process.env.STRIPE_REDIRECT_URI; // This is your stripeOAuthRedirect URL

        if (!clientId || !redirectUri) {
            console.error('Missing Stripe Client ID or Redirect URI environment variables.');
            return res.status(500).send('Server configuration error: Missing Stripe credentials.');
        }

        // Construct a STATE object that includes adaloUserId and the hardcoded redirect URLs
        const stateObject = {
            adaloUserId: adaloUserId,
            successUrl: ADALO_SUCCESS_URL, // Use hardcoded URL
            failureUrl: ADALO_FAILURE_URL  // Use hardcoded URL
        };
        const encodedState = encodeURIComponent(JSON.stringify(stateObject)); // JSON stringify and URL encode the state

        // Construct the FULL Stripe Connect OAuth URL with the encoded state object
        const onboardingUrl = `https://connect.stripe.com/oauth/authorize?response_type=code&client_id=${clientId}&scope=read_write&redirect_uri=${redirectUri}&state=${encodedState}`;

        console.log(`Generated full Stripe URL for Adalo: ${onboardingUrl}`);
        console.log(`Including encoded state object: ${encodedState}`);

        // Respond with the full onboarding URL. Adalo will use this directly.
        res.status(200).json({ onboardingUrl });

    } catch (error) {
        console.error('Error in Stripe Connect onboarding function:', error);
        res.status(500).send(`Error: ${error.message}`);
    }
});
