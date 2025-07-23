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

        // --- NEW STATE PARSING LOGIC START ---
        let adaloUserId;
        let adaloSuccessRedirectUrl; // This will now be dynamic
        let adaloFailureRedirectUrl; // This will now be dynamic

        // Define fallback Adalo redirect URLs (should only be used if state parsing fails critically)
        // These are generic fallbacks, ideally you'd have a very robust error page here.
        const FALLBACK_SUCCESS_URL = 'https://admin.activetopia.socialtopiahq.com/activetopia-admin-dashboard?status=connected';
        const FALLBACK_FAILURE_URL = 'https://admin.activetopia.socialtopiahq.com/activetopia-admin-dashboard?error=failed';


        if (!code) {
            console.error('Missing code in Stripe OAuth redirect.');
            return res.status(400).send('Missing code in redirect.');
        }

        if (state) {
            try {
                // This is the crucial part: decode and parse the JSON state object
                const decodedState = JSON.parse(decodeURIComponent(state));
                adaloUserId = decodedState.adaloUserId;
                adaloSuccessRedirectUrl = decodedState.successUrl; // Extract dynamic URL
                adaloFailureRedirectUrl = decodedState.failureUrl; // Extract dynamic URL
                console.log(`Parsed state object: Adalo userId: ${adaloUserId}, Success URL: ${adaloSuccessRedirectUrl}, Failure URL: ${adaloFailureRedirectUrl}`);
            } catch (parseError) {
                console.error(`Error parsing state parameter: ${parseError.message}. State received: ${state}`);
                // Fallback if state parsing fails (e.g., malformed JSON)
                adaloUserId = 'UNKNOWN_ADALO_USER_PARSE_ERROR';
                adaloSuccessRedirectUrl = FALLBACK_SUCCESS_URL;
                adaloFailureRedirectUrl = FALLBACK_FAILURE_URL;
            }
        } else {
            // This case should ideally not happen if stripeConnectOnboarding always sends state
            adaloUserId = 'UNKNOWN_ADALO_USER_NO_STATE';
            adaloSuccessRedirectUrl = FALLBACK_SUCCESS_URL;
            adaloFailureRedirectUrl = FALLBACK_FAILURE_URL;
            console.warn('WARNING: State parameter is completely missing. Using fallback URLs.');
        }
        // --- NEW STATE PARSING LOGIC END ---

        // Initialize Stripe instance if not already initialized
        if (!stripeInstance) {
            const stripeSecretKey = await getStripeSecretKey(secretManagerClientInstance); // Pass the initialized client
            stripeInstance = stripe(stripeSecretKey);
        }

        // 2. Exchange Stripe OAuth token for access token and connected account ID
        let stripeUserId;
        let charges_enabled;
        let payouts_enabled;
        let businessName = '';
        let businessAddress = '';
        let businessPhone = '';
        let businessWebsite = '';
        let businessDescription = '';
        let legalEntityType = '';
        let accountEmail = '';


        try {
            const tokenResponse = await stripeInstance.oauth.token({
                grant_type: 'authorization_code',
                code: code,
            });

            stripeUserId = tokenResponse.stripe_user_id;

            // Retrieve account details to get capabilities and business info
            const account = await stripeInstance.accounts.retrieve(stripeUserId);
            charges_enabled = account.charges_enabled;
            payouts_enabled = account.payouts_enabled;
            accountEmail = account.email || '';

            // Extract additional business information
            if (account.business_profile) {
                businessName = account.business_profile.name || '';
                businessWebsite = account.business_profile.url || '';
                businessPhone = account.business_profile.support_phone || '';
                businessDescription = account.business_profile.tagline || '';
            }

            // Extract address (prioritize company address if available, then individual)
            if (account.company && account.company.address) {
                const address = account.company.address;
                businessAddress = `${address.line1 || ''}, ${address.city || ''}, ${address.state || ''} ${address.postal_code || ''}, ${address.country || ''}`.trim().replace(/,(\s*,){1,}/g, ',').replace(/^,|,$/g, '');
            } else if (account.individual && account.individual.address) {
                const address = account.individual.address;
                businessAddress = `${address.line1 || ''}, ${address.city || ''}, ${address.state || ''} ${address.postal_code || ''}, ${address.country || ''}`.trim().replace(/,(\s*,){1,}/g, ',').replace(/^,|,$/g, '');
            }

            // Determine legal entity type
            if (account.type) {
                legalEntityType = account.type;
            }


            console.log(`Stripe OAuth successful for Adalo userId: ${adaloUserId}`);
            console.log(`Connected Stripe Account ID: ${stripeUserId}`);
            console.log(`Extracted Business Info: Name: ${businessName}, Address: ${businessAddress}, Phone: ${businessPhone}, Website: ${businessWebsite}, Description: ${businessDescription}, Legal Entity Type: ${legalEntityType}, Email: ${accountEmail}`);


        } catch (stripeOAuthError) {
            console.error('Error exchanging Stripe OAuth token:', stripeOAuthError.message);
            // Redirect to Adalo Stripe Failure URL, using dynamic URL if available, otherwise fallback
            return res.redirect(adaloFailureRedirectUrl + `&error=${encodeURIComponent('Stripe connection failed.')}`);
        }

        // --- Start of MODIFIED LOGIC for Adalo Update via Zapier ---
        // Removed direct Adalo API call as it consistently fails with "Access token / app mismatch"
        // Now, we always send the data to Zapier, and Zapier will handle the "find or create/update" logic.

        // **IMPORTANT: UPDATE THIS URL FOR EACH NEW CLIENT'S ZAPIER WEBHOOK**
        const ZAPIER_WEBHOOK_URL = 'https://hooks.zapier.com/hooks/catch/15675020/u2ac79c/'; // <--- UPDATE THIS URL FOR EACH CLIENT

        const payloadForZapier = {
            adaloUserId: adaloUserId,
            // adaloRecordId: adaloRecordIdToUpdate,
            stripeUserId: stripeUserId,
            chargesEnabled: charges_enabled,
            payoutsEnabled: payouts_enabled,
            accountStatus: 'active',
            businessName: businessName,
            businessAddress: businessAddress,
            businessPhone: businessPhone,
            businessWebsite: businessWebsite,
            businessDescription: businessDescription,
            legalEntityType: legalEntityType,
            accountEmail: accountEmail,
        };

        try {
            console.log('Sending data to Zapier Webhook:', payloadForZapier);
            await axios.post(ZAPIER_WEBHOOK_URL, payloadForZapier, {
                headers: { 'Content-Type': 'application/json' }
            });
            console.log('Successfully sent data to Zapier.');
        } catch (zapierError) {
            console.error('Error sending data to Zapier Webhook:', zapierError.message);
            if (zapierError.response) {
                console.error('Zapier Webhook Error Status:', zapierError.response.status);
                console.error('Zapier Webhook Error Data:', JSON.stringify(zapierError.response.data));
            }
        }

        // 3. Redirect user back to Adalo app after successful processing
        // Using the dynamic Adalo Success URL if available, otherwise fallback
        res.redirect(adaloSuccessRedirectUrl + `&status=connected&stripeId=${stripeUserId}`);

    } catch (overallError) {
        console.error('Overall error in stripeOAuthRedirect function:', overallError);
        // Redirect to a generic error page in Adalo or show a simple message
        // Using the dynamic Adalo Failure URL if available, otherwise fallback
        res.redirect(adaloFailureRedirectUrl + `&error=${encodeURIComponent('An unexpected error occurred.')}`);
    }
});
