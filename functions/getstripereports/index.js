// functions/getstripereports/index.js
// This file contains the Cloud Function for securely fetching Stripe reporting data.

// --- REQUIRED MODULE IMPORTS FOR THIS FUNCTION ---
const functions = require('firebase-functions');
const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');
const stripe = require('stripe');
const admin = require('firebase-admin'); // For Firebase Authentication and Firestore

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
        // 'https://clientA.yourdomain.com', // Example client app domain
        // 'https://clientB.yourdomain.com', // Example client app domain
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
        // --- Authentication (Firebase ID Token Verification) ---
        const idToken = req.headers.authorization ? req.headers.authorization.split('Bearer ')[1] : null;
        if (!idToken) {
            console.error('Authentication Error: No ID token provided.');
            return res.status(401).json({ error: 'Unauthorized: Authentication token required.' });
        }

        let decodedToken;
        try {
            decodedToken = await admin.auth().verifyIdToken(idToken);
            console.log(`Authenticated user UID: ${decodedToken.uid}`);
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

        // --- Authorization (CRITICAL for Multi-Client Security) ---
        // Verify that the authenticated user (decodedToken.uid) is authorized to view this stripeAccountId's data.
        // This queries your Firestore database (where Adalo stores its data) to find a matching record.

        const firestore = admin.firestore(); // Get Firestore instance

        // Query the "Gym Owners Stripe Accounts" collection
        // Replace 'Gym Owners Stripe Accounts' with the EXACT name of your collection in Firestore.
        // Replace 'Stripe Account ID' with the EXACT field name in your collection that stores the Stripe Account ID.
        // Replace 'User' with the EXACT field name in your collection that represents the relationship to the User collection.
        const gymStripeAccountQuery = await firestore.collection('Gym Owners Stripe Accounts')
                                                     .where('Stripe Account ID', '==', stripeAccountId)
                                                     .where('User', '==', decodedToken.uid) // Assuming 'User' is the relationship field storing the Adalo User ID (which matches decodedToken.uid)
                                                     .limit(1)
                                                     .get();

        if (gymStripeAccountQuery.empty) {
            console.error(`Authorization Error: User ${decodedToken.uid} attempted to access unauthorized or non-existent Stripe account ${stripeAccountId}.`);
            return res.status(403).json({ error: 'Forbidden: You are not authorized to view this account.' });
        }
        console.log(`Authorization successful for user ${decodedToken.uid} to access ${stripeAccountId}.`);


        console.log(`Fetching reports for connected account: ${stripeAccountId}`);

        // --- Fetch Stripe Data & Aggregations ---
        const now = new Date();
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        const startOfYear = new Date(now.getFullYear(), 0, 1);

        // Convert dates to Unix timestamps (seconds) for Stripe API
        const nowTimestamp = Math.floor(now.getTime() / 1000);
        const startOfMonthTimestamp = Math.floor(startOfMonth.getTime() / 1000);
        const startOfYearTimestamp = Math.floor(startOfYear.getTime() / 1000);

        // --- Helper to fetch all paginated charges ---
        async function fetchAllCharges(stripeAccountId, createdGte, createdLte) {
            let allCharges = [];
            let hasMore = true;
            let lastChargeId = null;

            while (hasMore) {
                const params = {
                    limit: 100, // Fetch 100 at a time
                    created: { gte: createdGte, lte: createdLte },
                    expand: ['customer'] // Expand customer object to get email for new/returning logic
                };
                if (lastChargeId) {
                    params.starting_after = lastChargeId;
                }

                const chargesPage = await stripeInstance.charges.list(params, { stripeAccount: stripeAccountId });
                allCharges = allCharges.concat(chargesPage.data);
                hasMore = chargesPage.has_more;
                if (hasMore && chargesPage.data.length > 0) {
                    lastChargeId = chargesPage.data[chargesPage.data.length - 1].id;
                } else {
                    hasMore = false; // Ensure loop terminates if no data on last page
                }
            }
            return allCharges;
        }

        // Fetch charges for MTD and YTD
        const mtdCharges = await fetchAllCharges(stripeAccountId, startOfMonthTimestamp, nowTimestamp);
        const ytdCharges = await fetchAllCharges(stripeAccountId, startOfYearTimestamp, nowTimestamp);

        // Fetch recent payouts and balance (as before)
        const recentPayouts = await stripeInstance.payouts.list(
            { limit: 10 },
            { stripeAccount: stripeAccountId }
        );
        const balance = await stripeInstance.balance.retrieve(
            { stripeAccount: stripeAccountId }
        );

        // --- Aggregations ---
        // Total Revenue (MTD & YTD)
        const totalRevenueMTD = mtdCharges.filter(c => c.paid && !c.refunded).reduce((sum, charge) => sum + charge.amount, 0);
        const totalRevenueYTD = ytdCharges.filter(c => c.paid && !c.refunded).reduce((sum, charge) => sum + charge.amount, 0);

        // Total Transactions (MTD & YTD)
        const totalTransactionsMTD = mtdCharges.filter(c => c.paid).length;
        const totalTransactionsYTD = ytdCharges.filter(c => c.paid).length;

        // Refunds Amount (MTD & YTD)
        const refundsAmountMTD = mtdCharges.filter(c => c.refunded).reduce((sum, charge) => sum + charge.amount_refunded, 0);
        const refundsAmountYTD = ytdCharges.filter(c => c.refunded).reduce((sum, charge) => sum + charge.amount_refunded, 0);

        // Average Transaction Value (MTD & YTD)
        const averageTransactionValueMTD = totalTransactionsMTD > 0 ? totalRevenueMTD / totalTransactionsMTD : 0;
        const averageTransactionValueYTD = totalTransactionsYTD > 0 ? totalRevenueYTD / totalTransactionsYTD : 0;

        // Customer Counts (New/Returning - basic logic, can be refined)
        const allCustomerEmails = ytdCharges.filter(c => c.customer && c.customer.email).map(c => c.customer.email);
        const uniqueCustomerEmails = new Set(allCustomerEmails);
        const totalCustomers = uniqueCustomerEmails.size;

        // For new/returning, you'd typically need to query customer objects directly or rely on metadata/timestamps.
        // This is a simplified approach assuming 'customer.created' is reliable for 'new' within the period.
        // For more accurate new/returning, you'd fetch customer objects and check created dates.
        const newCustomersMTD = mtdCharges.filter(c => c.customer && Math.floor(c.customer.created * 1000) >= startOfMonth.getTime()).length; // Simplified
        const returningCustomersMTD = totalCustomers - newCustomersMTD; // Simplified

        // Transaction Fees (Stripe does not expose this directly per charge via API list, requires balance transactions or webhooks)
        // For this, you'd typically sum fees from balance transactions or rely on webhooks.
        // Placeholder for now, as it's complex to aggregate accurately from charges.list
        const totalTransactionFeesMTD = 0; // Requires fetching Balance Transactions or parsing webhooks
        const totalTransactionFeesYTD = 0; // Requires fetching Balance Transactions or parsing webhooks


        console.log("Successfully aggregated Stripe data.");

        // Respond with the fetched and aggregated data
        res.status(200).json({
            // Raw data
            recentCharges: mtdCharges.slice(0, 10), // Still return recent 10 for display
            recentPayouts: recentPayouts.data,
            balance: balance,
            stripeAccountId: stripeAccountId,

            // Aggregated data
            reportDate: now.toISOString().split('T')[0], // Current date for the report
            currentMTDRevenue: totalRevenueMTD,
            currentYTDRevenue: totalRevenueYTD,
            totalTransactionsMTD: totalTransactionsMTD,
            totalTransactionsYTD: totalTransactionsYTD,
            averageTransactionValueMTD: averageTransactionValueMTD,
            averageTransactionValueYTD: averageTransactionValueYTD,
            refundsAmountMTD: refundsAmountMTD,
            refundsAmountYTD: refundsAmountYTD,
            totalCustomers: totalCustomers,
            newCustomersMTD: newCustomersMTD,
            returningCustomersMTD: returningCustomersMTD,
            totalTransactionFeesMTD: totalTransactionFeesMTD,
            totalTransactionFeesYTD: totalTransactionFeesYTD,
            // You can add previous_mtd, mtd_comparison_value, mtd_comparison_percent
            // by fetching previous month's data and calculating
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
