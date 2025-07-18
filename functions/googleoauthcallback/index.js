// functions/googleoauthcallback/index.js
// This file contains the Cloud Function for handling Google OAuth callbacks.

// --- REQUIRED MODULE IMPORTS FOR THIS FUNCTION ---
const functions = require('firebase-functions');
const axios = require('axios');
const admin = require('firebase-admin'); // Required for initializing Firebase Admin SDK
const { Firestore } = require('@google-cloud/firestore'); // Required for Firestore client

// --- Initialize Firebase Admin SDK (must be called only once per function instance) ---
admin.initializeApp();
const db = new Firestore({
    databaseId: '(default)' // This is the correct Database ID to use for the default Firestore instance
});


// --- googleOAuthCallback Function Definition ---
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
        // Using the provided Adalo Stripe Failure URL for consistency
        return res.redirect(`https://admin.activetopia.socialtopiahq.com/activetopia-admin-dashboard?target=7s13zskf7e6tstip9ocx379h0&params=%7B%7D&message=google_oauth_error&detail=${encodeURIComponent(error)}`);
    }

    if (!code) {
        console.error("Error: Missing 'code' parameter in Google OAuth redirect.");
        // Using the provided Adalo Stripe Failure URL for consistency
        return res.redirect(`https://admin.activetopia.socialtopiahq.com/activetopia-admin-dashboard?target=7s13zskf7e6tstip9ocx379h0&params=%7B%7D&message=google_code_missing`);
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
        // Using the provided Adalo Stripe Success URL for consistency
        return res.redirect(`https://admin.activetopia.socialtopiahq.com/activetopia-admin-dashboard?target=11909pzspdjskfsa7ubpukgup&params=%7B%7D&adalo_user_id=${adaloUserId}&google_auth_success=true`);

    } catch (error) {
        console.error("Error during Google OAuth process:", error);
        const errorMessage = encodeURIComponent(error.message || "An unknown error occurred during Google Auth.");
        // Using the provided Adalo Stripe Failure URL for consistency
        return res.redirect(`https://admin.activetopia.socialtopiahq.com/activetopia-admin-dashboard?target=7s13zskf7e6tstip9ocx379h0&params=%7B%7D&error=${errorMessage}`);
    }
});
