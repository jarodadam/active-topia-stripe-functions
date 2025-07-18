// functions/testsecretaccess/index.js
// This file contains a Cloud Function to test access to secrets.

// --- REQUIRED MODULE IMPORTS FOR THIS FUNCTION ---
const functions = require('firebase-functions');
const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');

// --- Shared Secret Manager Setup for this function ---
const secretManagerClient = new SecretManagerServiceClient();

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


// --- testSecretAccess Function Definition ---
exports.testSecretAccess = functions.https.onRequest(async (req, res) => {
    // Set CORS headers
    res.set('Access-Control-Allow-Origin', 'https://admin.activetopia.socialtopiahq.com'); // Restrict to your Adalo admin domain
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
