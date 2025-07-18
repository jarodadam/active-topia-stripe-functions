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
        // Initialize Stripe instance if not already initialized
        if (!stripeInstance) { // Using the shared stripeInstance
            const stripeSecretKey = await getStripeSecretKey(); // Using the shared getStripeSecretKey
            stripeInstance = stripe(stripeSecretKey);
        }

        // Ensure your environment variables are correctly set for the Cloud Function.
        const clientId = process.env.STRIPE_CLIENT_ID;
        const redirectUri = process.env.STRIPE_REDIRECT_URI;

        if (!clientId || !redirectUri) {
            console.error('Missing Stripe Client ID or Redirect URI environment variables.');
            return res.status(500).send('Server configuration error: Missing Stripe credentials.');
        }

        // Construct the BASE Stripe Connect OAuth URL (without the 'state' parameter for now)
        const onboardingUrl = `https://connect.stripe.com/oauth/authorize?response_type=code&client_id=${clientId}&scope=read_write&redirect_uri=${redirectUri}`;

        console.log(`Generated base Stripe URL for Adalo: ${onboardingUrl}`);
        console.log("CONFIRMED: Deployed new version without userId check.");

        // Respond with the base onboarding URL. Adalo's "Link to Website" will then append the userId.
        res.status(200).json({ onboardingUrl });

    } catch (error) {
        console.error('Error in Stripe Connect onboarding function:', error);
        res.status(500).send(`Error: ${error.message}`);
    }
});
