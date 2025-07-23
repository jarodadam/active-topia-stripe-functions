// functions/getstripereports/index.js
// This file contains the Cloud Function for securely fetching Stripe reporting data.

// --- REQUIRED MODULE IMPORTS FOR THIS FUNCTION ---
const functions = require('firebase-functions');
const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');
const stripe = require('stripe');
const admin = require('firebase-admin'); // For Firebase Authentication

// --- Initialize Firebase Admin SDK (must be called only once per function instance) ---
// Ensure this is initialized only once across your Cloud Function instances
if (!admin.apps.length) {
    admin.initializeApp();
}

// --- Shared Stripe/Secret Manager Setup ---
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


// --- getStripeReports Function Definition ---
exports.getStripeReports = functions.https.onRequest(async (req, res) => {
    console.log("--- getStripeReports Function Called ---");
    console.log("Request Query Params:", req.query);
    console.log("Request Body:", req.body); // Expecting stripeAccountId in body
    console.log("Request Origin:", req.headers.origin); // Log the origin for CORS debugging

    // --- CORS Handling for White-Labeling ---
    // In production, you would maintain a list of allowed client domains.
    // For testing, '*' is used, but it's INSECURE for production.
    const allowedOrigins = [
        'https://clientA.yourdomain.com', // Example client app domain
        'https://clientB.yourdomain.com', // Example client app domain
        // Add all your white-labeled app domains here
        // For local development/testing, you might need to add 'http://localhost:XXXX'
    ];
    const requestOrigin = req.headers.origin;

    if (requestOrigin && allowedOrigins.includes(requestOrigin)) {
        res.set('Access-Control-Allow-Origin', requestOrigin);
    } else {
        // For initial testing, allow all, but this needs to be restricted in production
        res.set('Access-Control-Allow-Origin', '*');
    }

    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization'); // Add Authorization header
    res.set('Access-Control-Max-Age', '3600'); // Cache preflight requests for 1 hour

    // Handle preflight OPTIONS request
    if (req.method === 'OPTIONS') {
        res.status(204).send('');
        return;
    }

    try {
        // --- Authentication and Authorization (CRUCIAL for Security) ---
        // 1. Authenticate the user: Verify the Firebase ID token from the client-side app.
        const idToken = req.headers.authorization ? req.headers.authorization.split('Bearer ')[1] : null;
        if (!idToken) {
            console.error('Authentication Error: No ID token provided.');
            return res.status(401).json({ error: 'Unauthorized: Authentication token required.' });
        }

        let decodedToken;
        try {
            decodedToken = await admin.auth().verifyIdToken(idToken);
            console.log(`Authenticated user: ${decodedToken.uid}`);
        } catch (authError) {
            console.error('Authentication Error: Invalid ID token.', authError);
            return res.status(401).json({ error: 'Unauthorized: Invalid authentication token.' });
        }

        // Initialize Stripe instance if not already initialized
        if (!stripeInstance) {
            const stripeSecretKey = await getStripeSecretKey();
            stripeInstance = stripe(stripeSecretKey);
        }

        // Extract stripeAccountId from the request body
        const { stripeAccountId } = req.body;

        if (!stripeAccountId) {
            console.error('Missing stripeAccountId in request body.');
            return res.status(400).json({ error: 'Missing Stripe Account ID.' });
        }

        // 2. Authorize the user: Ensure the authenticated user is allowed to view this stripeAccountId's data.
        // This is a placeholder. You need to implement YOUR OWN logic here.
        // Example: Fetch the user's record from Firestore and check if their associated
        // Gym Owners Stripe Account ID matches the requested stripeAccountId.
        // For example, if you store user's stripeAccountId in their Adalo user record or a related collection.
        // const userDoc = await admin.firestore().collection('users').doc(decodedToken.uid).get();
        // const userStripeAccountId = userDoc.data()?.stripeAccountId; // Assuming you store it here

        // if (userStripeAccountId !== stripeAccountId) {
        //     console.error(`Authorization Error: User ${decodedToken.uid} attempted to access unauthorized Stripe account ${stripeAccountId}.`);
        //     return res.status(403).json({ error: 'Forbidden: You are not authorized to view this account.' });
        // }
        // console.log(`Authorization successful for user ${decodedToken.uid} to access ${stripeAccountId}.`);


        console.log(`Fetching reports for connected account: ${stripeAccountId}`);

        // --- Fetch Stripe Data ---
        // Example: Fetching a list of charges for the connected account
        const charges = await stripeInstance.charges.list(
            { limit: 10 }, // Adjust limit as needed, implement pagination for large datasets
            { stripeAccount: stripeAccountId } // CRUCIAL for Connect platforms
        );

        // Example: Fetching a list of payouts for the connected account
        const payouts = await stripeInstance.payouts.list(
            { limit: 10 }, // Adjust limit as needed
            { stripeAccount: stripeAccountId }
        );

        // Example: Fetching the balance for the connected account
        const balance = await stripeInstance.balance.retrieve(
            { stripeAccount: stripeAccountId }
        );


        console.log("Successfully fetched Stripe data.");

        // Respond with the fetched data
        res.status(200).json({
            charges: charges.data,
            payouts: payouts.data,
            balance: balance,
            stripeAccountId: stripeAccountId // Echo back the account ID for client-side verification
        });

    } catch (error) {
        console.error('Error in getStripeReports function:', error);
        // Handle specific Stripe errors
        if (error.type === 'StripeCardError' || error.type === 'StripeInvalidRequestError') {
            return res.status(400).json({ error: error.message });
        }
        res.status(500).json({ error: `Failed to fetch Stripe reports: ${error.message}` });
    }
});
