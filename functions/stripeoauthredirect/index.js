// functions/stripeoauthredirect/index.js
// This file contains the Cloud Function for handling Stripe OAuth redirects.

// --- REQUIRED MODULE IMPORTS FOR THIS FUNCTION ---
const functions = require('firebase-functions');
const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');
const stripe = require('stripe');
const axios = require('axios'); // Used for Adalo API calls and Zapier webhook
const admin = require('firebase-admin'); // Required for initializing Firebase Admin SDK
const { Firestore } = require('@google-cloud/firestore'); // Required for Firestore client

// --- Initialize Firebase Admin SDK (must be called only once per function instance) ---
admin.initializeApp();

// Declare variables for lazy initialization
let dbInstance;
let secretManagerClientInstance;
let stripeInstance;

// Helper function to get Stripe Secret Key
async function getStripeSecretKey(client) { // Pass client as argument
    const projectId = process.env.GCP_PROJECT;
    if (!projectId) {
        throw new Error('GCP_PROJECT environment variable is not set. Cannot access Stripe secret key.');
    }
    const secretPath = `projects/${projectId}/secrets/stripe-secret-key/versions/latest`;

    console.log(`Attempting to access secret at: ${secretPath}`);

    try {
        const [version] = await client.accessSecretVersion({ // Use passed client
            name: secretPath,
        });
        return version.payload.data.toString('utf8');
    } catch (error) {
        console.error(`Error accessing secret in getStripeSecretKey: ${error.message}`);
        throw new Error(`Failed to retrieve Stripe Secret Key: ${error.message}`);
    }
}


// --- stripeOAuthRedirect Function Definition ---
exports.stripeOAuthRedirect = functions.https.onRequest(async (req, res) => {
    // Set CORS headers
    res.set('Access-Control-Allow-Origin', '*'); // Restrict this to your Adalo domain in production
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');

    // Handle preflight OPTIONS request
    if (req.method === 'OPTIONS') {
        res.status(204).send('');
        return;
    }

    try {
        // Lazy initialization of Firestore and Secret Manager Client
        if (!dbInstance) {
            dbInstance = new Firestore({
                databaseId: '(default)'
            });
        }
        if (!secretManagerClientInstance) {
            secretManagerClientInstance = new SecretManagerServiceClient();
        }

        // 1. Extract state (Adalo User ID) and authorization_code from req.query
        const { state, code } = req.query;

        if (!state || !code) {
            console.error('Missing state or code in Stripe OAuth redirect.');
            return res.status(400).send('Missing code or code in redirect.');
        }

        const adaloUserId = state; // Assuming 'state' directly contains the Adalo User ID

        // Initialize Stripe instance if not already initialized
        if (!stripeInstance) {
            const stripeSecretKey = await getStripeSecretKey(secretManagerClientInstance); // Pass the initialized client
            stripeInstance = stripe(stripeSecretKey);
        }

        // 2. Exchange Stripe OAuth token for access token and connected account ID
        let stripeUserId;
        let charges_enabled;
        let payouts_enabled;

        try {
            const tokenResponse = await stripeInstance.oauth.token({
                grant_type: 'authorization_code',
                code: code,
            });

            stripeUserId = tokenResponse.stripe_user_id;

            // Retrieve account details to get capabilities
            const account = await stripeInstance.accounts.retrieve(stripeUserId);
            charges_enabled = account.charges_enabled;
            payouts_enabled = account.payouts_enabled;

            console.log(`Stripe OAuth successful for Adalo userId: ${adaloUserId}`);
            console.log(`Connected Stripe Account ID: ${stripeUserId}`);

        } catch (stripeOAuthError) {
            console.error('Error exchanging Stripe OAuth token:', stripeOAuthError.message);
            // Redirect to Adalo Stripe Failure URL
            return res.redirect(`https://admin.activetopia.socialtopiahq.com/activetopia-admin-dashboard?target=7s13zskf7e6tstip9ocx379h0&params=%7B%7D&error=${encodeURIComponent('Stripe connection failed.')}`);
        }

        // --- Start of MODIFIED LOGIC for Adalo Update via Zapier ---
        // Removed direct Adalo API call as it consistently fails with "Access token / app mismatch"
        // Now, we always send the data to Zapier, and Zapier will handle the "find or create/update" logic.

        // Zapier Webhook URL for updating Adalo
        const ZAPIER_WEBHOOK_URL = 'https://hooks.zapier.com/hooks/catch/15675020/u2ac79c/'; // YOUR ZAPIER WEBHOOK URL

        const payloadForZapier = {
            adaloUserId: adaloUserId,
            // adaloRecordId: adaloRecordIdToUpdate, // Removed: This was obtained via the failing Adalo API GET
            stripeUserId: stripeUserId,
            chargesEnabled: charges_enabled,
            payoutsEnabled: payouts_enabled,
            accountStatus: 'active', // Example status
            // Add any other relevant data you want to update in Adalo
            // e.g., businessName: 'Jarods Gym Cuz' (if you have it)
        };

        try {
            console.log('Sending data to Zapier Webhook:', payloadForZapier);
            await axios.post(ZAPIER_WEBHOOK_URL, payloadForZapier, {
                headers: { 'Content-Type': 'application/json' }
            });
            console.log('Successfully sent data to Zapier.');
        } catch (zapierError) {
            console.error('Error sending data to Zapier Webhook:', zapierError.message);
            // Log full error response if available
            if (zapierError.response) {
                console.error('Zapier Webhook Error Status:', zapierError.response.status);
                console.error('Zapier Webhook Error Data:', JSON.stringify(zapierError.response.data));
            }
            // Decide if this error should prevent redirecting the user back to Adalo
        }

        // --- End of MODIFIED LOGIC ---

        // 3. Redirect user back to Adalo app after successful processing
        // Using the provided Adalo Stripe Success URL
        // You might append parameters to indicate success or the connected account ID
        res.redirect(`https://admin.activetopia.socialtopiahq.com/activetopia-admin-dashboard?target=11909pzspdjskfsa7ubpukgup&params=%7B%7D&status=connected&stripeId=${stripeUserId}`);

    } catch (overallError) {
        console.error('Overall error in stripeOAuthRedirect function:', overallError);
        // Redirect to a generic error page in Adalo or show a simple message
        // Using the provided Adalo Stripe Failure URL
        res.redirect(`https://admin.activetopia.socialtopiahq.com/activetopia-admin-dashboard?target=7s13zskf7e6tstip9ocx379h0&params=%7B%7D&error=${encodeURIComponent('An unexpected error occurred.')}`);
    }
});
