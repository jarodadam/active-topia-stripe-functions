    // functions/index.js
    // This file acts as the main entry point for all your Cloud Functions.
    // All individual function code has been consolidated here for robust deployment.

    // --- ALL REQUIRED MODULE IMPORTS AT THE VERY TOP ---
    const functions = require('firebase-functions');
    const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');
    const stripe = require('stripe');
    const axios = require('axios'); // Used by stripeOAuthRedirect
    const admin = require('firebase-admin'); // Required by getGymProducts, googleOAuthCallback, onboarding
    const { Firestore } = require('@google-cloud/firestore'); // Required by getGymProducts (Firestore client)

    // --- Initialize Firebase Admin SDK (must be called only once) ---
    admin.initializeApp();
    // Explicitly connect to the default Firestore database for getGymProducts
    const db = new Firestore({
        databaseId: '(default)' // This is the correct Database ID to use
    });


    // --- Shared Stripe/Secret Manager Setup (if used by multiple functions) ---
    const secretManagerClient = new SecretManagerServiceClient();
    let stripeInstance; // To store the initialized Stripe instance once retrieved

    // Helper function to get Stripe Secret Key (used by multiple functions)
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


    // --- Individual Cloud Function Definitions (Consolidated) ---


    // 1. stripeOAuthRedirect Function (Previously in stripeOAuthRedirect_function/index.js)
    //    This function's code is directly embedded here.
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
        // 1. Extract state (Adalo User ID) and authorization_code from req.query
        const { state, code } = req.query;

        if (!state || !code) {
        console.error('Missing state or code in Stripe OAuth redirect.');
        return res.status(400).send('Missing code or code in redirect.');
        }

        const adaloUserId = state; // Assuming 'state' directly contains the Adalo User ID

        // Initialize Stripe instance if not already initialized
        if (!stripeInstance) {
        const stripeSecretKey = await getStripeSecretKey();
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
        // Redirect to an error page in Adalo or show an error
        return res.redirect(`YOUR_ADALO_APP_ERROR_URL?error=${encodeURIComponent('Stripe connection failed.')}`);
        }

        // --- Start of NEW LOGIC for Adalo Update via Zapier ---

        // Ensure these environment variables are set in your Cloud Function settings
        const ADALO_API_KEY = process.env.ADALO_API_KEY;
        const ADALO_APP_ID = process.env.ADALO_APP_ID;
        const ADALO_GYM_OWNER_STRIPE_COLLECTION_ID = process.env.ADALO_GYM_OWNER_STRIPE_COLLECTION_ID; // This should be the ID for "Gym Owners Stripe Account"

        if (!ADALO_API_KEY || !ADALO_APP_ID || !ADALO_GYM_OWNER_STRIPE_COLLECTION_ID) {
            console.error('Missing Adalo API environment variables.');
            return res.status(500).send('Server configuration error: Adalo API keys missing.');
        }

        let adaloRecordIdToUpdate = null;

        try {
            // Construct the URL to get records from the collection, filtered by the User relationship
            // Assuming 'User' is the API Name of your relationship field in Adalo
            // And assuming filtering by relationship ID directly works.
            // Example: https://api.adalo.com/v0/apps/APP_ID/collections/COLLECTION_ID?User=USER_ID
            const adaloGetUrl = `https://api.adalo.com/v0/apps/${ADALO_APP_ID}/collections/${ADALO_GYM_OWNER_STRIPE_COLLECTION_ID}?User=${adaloUserId}`;

            console.log('Attempting to fetch Adalo record for user:', adaloUserId, 'from URL:', adaloGetUrl);
            const adaloGetResponse = await axios.get(adaloGetUrl, {
                headers: {
                    'Authorization': `Bearer ${ADALO_API_KEY}`,
                    'Content-Type': 'application/json'
                }
            });

            if (adaloGetResponse.data.records && adaloGetResponse.data.records.length > 0) {
                // Assuming the first record found is the correct one
                adaloRecordIdToUpdate = adaloGetResponse.data.records[0].id;
                console.log('Found Adalo record ID for update:', adaloRecordIdToUpdate);
            } else {
                console.warn('No existing Adalo record found for user ID:', adaloUserId, 'Proceeding without a specific record ID for Zapier update (Zapier might need to create).');
                // If the record doesn't exist, Zapier's "Update Record" might fail.
                // You might need a "Create Record" step in Zapier, or a "Find or Create" logic.
            }

        } catch (adaloGetError) {
            console.error('Error fetching Adalo record ID via GET:', adaloGetError.message);
            // Log the full error response if available for more details
            if (adaloGetError.response) {
                console.error('Adalo GET Error Status:', adaloGetError.response.status);
                console.error('Adalo GET Error Data:', JSON.stringify(adaloGetError.response.data));
            }
            // Continue, but adaloRecordIdToUpdate will be null
        }

        // Zapier Webhook URL for updating Adalo
        const ZAPIER_WEBHOOK_URL = 'https://hooks.zapier.com/hooks/catch/15675020/u2ac79c/'; // YOUR ZAPIER WEBHOOK URL

        const payloadForZapier = {
            adaloUserId: adaloUserId,
            adaloRecordId: adaloRecordIdToUpdate, // Include the found Adalo Record ID (will be null if not found)
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

        // --- End of NEW LOGIC ---

        // 3. Redirect user back to Adalo app after successful processing
        // IMPORTANT: Replace with your actual Adalo success/dashboard URL
        // You might append parameters to indicate success or the connected account ID
        res.redirect(`YOUR_ADALO_APP_SUCCESS_URL?status=connected&stripeId=${stripeUserId}`);

    } catch (overallError) {
        console.error('Overall error in stripeOAuthRedirect function:', overallError);
        // Redirect to a generic error page in Adalo or show a simple message
        res.redirect(`YOUR_ADALO_APP_ERROR_URL?error=${encodeURIComponent('An unexpected error occurred.')}`);
    }
    });


    // 2. getGymProducts Function (Previously in get-gym-products-function/index.js)
    exports.getGymProducts = functions.https.onRequest(async (req, res) => {
    // Set CORS headers to allow requests from your Firebase Hosted shop.html
    res.set('Access-Control-Allow-Origin', 'https://activetopia-stripe-backe-9690d.web.app'); // REPLACE THIS WITH YOUR ACTUAL FIREBASE HOSTING URL
    res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.status(204).send('');
        return;
    }

    try {
        const gymId = req.query.gymId; // Expecting gymId as a query parameter from shop.html

        if (!gymId) {
        console.error('getGymProducts: Missing gymId query parameter.');
        return res.status(400).send({ error: 'Missing gymId query parameter.' });
        }

        // Query Firestore for products matching the gymId
        const productsRef = db.collection('gymProducts'); // Firestore collection name
        const snapshot = await productsRef.where('gymId', '==', gymId).get();

        if (snapshot.empty) {
        console.log('getGymProducts: No products found for gymId:', gymId);
        return res.status(200).json([]); // Return empty array if no products found
        }

        const products = [];
        snapshot.forEach(doc => {
        products.push({ id: doc.id, ...doc.data() });
        });

        res.status(200).json(products);

    } catch (error) {
        console.error('Error retrieving gym products:', error);
        // Clean, production-ready error response
        res.status(500).send({ error: 'Failed to retrieve products.' });
    }
    });


    // 3. googleOAuthCallback Function (Previously in googleOAuthCallback_function/index.js)
    exports.googleOAuthCallback = functions.https.onRequest(async (req, res) => {
    console.log("--- Google OAuth Callback Function Called ---");
    console.log("Request Query Params:", req.query);

    // Configuration from Environment Variables
    const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
    const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
    const ADALO_API_KEY = process.env.ADALO_API_KEY;
    const ADALO_APP_ID = process.env.ADALO_APP_ID;
    const ADALO_USER_COLLECTION_ID = process.env.ADALO_USER_COLLECTION_ID;
    // This is the URL of THIS Cloud Function, registered as a redirect URI in Google API Console.
    const REDIRECT_URI = 'https://us-central1-activetopia-stripe-backend.cloudfunctions.net/googleOAuthCallback'; // Ensure this is correct

    const code = req.query.code;
    const error = req.query.error;
    const state = req.query.state; // This 'state' could be used for security (CSRF) or to pass user context

    if (error) {
        console.error("Google OAuth Error:", error);
        // Redirect back to Adalo with an error message
        // IMPORTANT: REPLACE 'https://your-adalo-app-domain.adalo.com' with your actual Adalo app domain
        return res.redirect(`https://your-adalo-app-domain.adalo.com/error-page?message=google_oauth_error&detail=${encodeURIComponent(error)}`);
    }

    if (!code) {
        console.error("Error: Missing 'code' parameter in Google OAuth redirect.");
        // IMPORTANT: REPLACE 'https://your-adalo-app-domain.adalo.com' with your actual Adalo app domain
        return res.redirect(`https://your-adalo-app-domain.adalo.com/error-page?message=google_code_missing`);
    }

    try {
        // 1. Exchange the authorization 'code' for access tokens with Google
        const tokenExchangeResponse = await axios.post('https://oauth2.googleapis.com/token',
        new URLSearchParams({
            code: code,
            client_id: GOOGLE_CLIENT_ID,
            client_secret: GOOGLE_CLIENT_SECRET,
            redirect_uri: REDIRECT_URI,
            grant_type: 'authorization_code'
        }).toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
        );

        const tokenData = tokenExchangeResponse.data;
        const accessToken = tokenData.access_token;
        const idToken = tokenData.id_token; // Contains user profile info

        // 2. (Optional but Recommended) Get user profile information from Google
        const userInfoResponse = await axios.get('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { 'Authorization': `Bearer ${accessToken}` }
        });

        const userInfo = userInfoResponse.data;
        const adaloApiUrl = `https://api.adalo.com/app/${process.env.ADALO_APP_ID}/collections/${process.env.ADALO_USER_COLLECTION_ID}/records`;

        // --- Example: Find or Create User in Adalo based on email
        let adaloUserId;
        let adaloUserExists = false;

        // Try to find user by email first
        const findUserResponse = await axios.get(`${adaloApiUrl}?email=${encodeURIComponent(userInfo.email)}`, {
        headers: { 'Authorization': `Bearer ${ADALO_API_KEY}` }
        });

        const findUserData = findUserResponse.data;

        if (findUserData.records && findUserData.records.length > 0) {
        adaloUserId = findUserData.records[0].id;
        adaloUserExists = true;
        console.log('Adalo user found:', adaloUserId);
        // If user exists, you might want to update their Google-specific fields here if needed
        // e.g., await axios.put(`${adaloApiUrl}/${adaloUserId}`, { 'google_access_token': accessToken, ... });
        } else {
        // User not found, create a new one
        console.log("Adalo user not found, creating new user.");
        const createUserResponse = await axios.post(adaloApiUrl, {
            email: userInfo.email,
            name: userInfo.name || userInfo.given_name,
            google_id: userInfo.sub,
            profile_picture: userInfo.picture // Example field
            // Add other fields as needed based on your Adalo User collection
        }, {
            headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${ADALO_API_KEY}`
            }
        });

        const newUserData = createUserResponse.data;
        adaloUserId = newUserData.id;
        console.log('New Adalo user created:', adaloUserId);
        }
        // --- End Example: Find or Create User

        // Redirect back to Adalo, potentially logging the user in or passing user info
        // You might need to configure Adalo to accept a user ID from the URL for Login.
        // IMPORTANT: REPLACE 'https://your-adalo-app-domain.adalo.com' with your actual Adalo app domain
        return res.redirect(`https://your-adalo-app-domain.adalo.com/home?adalo_user_id=${adaloUserId}&google_auth_success=true`);

    } catch (error) {
        console.error("Error during Google OAuth process:", error);
        const errorMessage = encodeURIComponent(error.message || "An unknown error occurred during Google Auth.");
        // IMPORTANT: REPLACE 'https://your-adalo-app-domain.adalo.com' with your actual Adalo app domain
        return res.redirect(`https://your-adalo-app-domain.adalo.com/error-page?message=${errorMessage}`);
    }
    });


    // 5. stripeConnectOnboarding Function (Previously in onboarding-function/index.js)
    exports.stripeConnectOnboarding = functions.https.onRequest(async (req, res) => {
    console.log("--- stripeConnectOnboarding Function Called ---");
    console.log("Request Query Params:", req.query);

    // Set CORS headers to allow requests from your Adalo app
    res.set('Access-Control-Allow-Origin', '*');
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


    // 6. testSecretAccess Function (Previously in test-secret-access-function/index.js)
    exports.testSecretAccess = functions.https.onRequest(async (req, res) => {
    // Set CORS headers
    res.set('Access-Control-Allow-Origin', '*'); // Consider restricting this to your Adalo domain in production
    res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');

    // Handle preflight OPTIONS request
    if (req.method === 'OPTIONS') {
        res.status(204).send('');
        return;
    }

    console.log("--- testSecretAccess Function Called ---");

    try {
        const stripeSecretKey = await getStripeSecretKey(); // Use the shared helper function
        res.status(200).send(`Secret accessed successfully! Key starts with: ${stripeSecretKey.substring(0, 5)}`);
    } catch (error) {
        console.error("Error accessing secret:", error);
        res.status(500).send(`Failed to access secret: ${error.message}`);
    }
    });
