const functions = require('firebase-functions');
const fetch = require('node-fetch'); // For making HTTP requests to Google and Adalo

// --- Configuration from Environment Variables ---
// These MUST be set in your Cloud Function's environment variables in Google Cloud Console.
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const ADALO_API_KEY = process.env.ADALO_API_KEY;
const ADALO_APP_ID = process.env.ADALO_APP_ID;
const ADALO_USER_COLLECTION_ID = process.env.ADALO_USER_COLLECTION_ID;

// This is the URL of THIS Cloud Function, registered as a redirect URI in Google API Console.
const REDIRECT_URI = 'https://us-central1-activetopia-stripe-backend.cloudfunctions.net/googleOAuthCallback';

exports.googleOAuthCallback = functions.https.onRequest(async (req, res) => {
    console.log("--- Google OAuth Callback Function Called ---");
    console.log("Request Query Params:", req.query);

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
        const tokenExchangeResponse = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams({
                code: code,
                client_id: GOOGLE_CLIENT_ID,
                client_secret: GOOGLE_CLIENT_SECRET,
                redirect_uri: REDIRECT_URI,
                grant_type: 'authorization_code'
            }).toString()
        });

        if (!tokenExchangeResponse.ok) {
            const errorData = await tokenExchangeResponse.json();
            console.error("Error exchanging Google token:", errorData);
            throw new Error(`Google token exchange failed: ${errorData.error_description || errorData.error}`);
        }

        const tokenData = await tokenExchangeResponse.json();
        const accessToken = tokenData.access_token;
        const idToken = tokenData.id_token; // Contains user profile info

        // 2. (Optional but Recommended) Get user profile information from Google
        const userInfoResponse = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
            headers: {
                'Authorization': `Bearer ${accessToken}`
            }
        });

        if (!userInfoResponse.ok) {
            const errorData = await userInfoResponse.json();
            console.error("Error fetching Google user info:", errorData);
            throw new Error(`Failed to fetch Google user info: ${errorData.message}`);
        }

        const userInfo = await userInfoResponse.json();
        console.log("Google User Info:", userInfo);

        // 3. Authenticate/Create user in Adalo
        // You'll need to decide how to map Google user info to your Adalo Users collection.
        // For example, use userInfo.email as a unique identifier.
        // If user exists, update; otherwise, create.

        const adaloApiUrl = `https://api.adalo.com/app/${ADALO_APP_ID}/collections/${ADALO_USER_COLLECTION_ID}/records`;

        // --- Example: Find or Create User in Adalo based on email ---
        let adaloUserId;
        let adaloUserExists = false;

        // Try to find user by email first
        const findUserResponse = await fetch(`${adaloApiUrl}?email=${encodeURIComponent(userInfo.email)}`, {
            headers: {
                'Authorization': `Bearer ${ADALO_API_KEY}`
            }
        });
        const findUserData = await findUserResponse.json();

        if (findUserData.records && findUserData.records.length > 0) {
            adaloUserId = findUserData.records[0].id;
            adaloUserExists = true;
            console.log(`Adalo user found: ${adaloUserId}`);
            // If user exists, you might want to update their Google-specific fields here if needed
            // e.g., await fetch(`${adaloApiUrl}/${adaloUserId}`, { method: 'PUT', ... });
        } else {
            // User not found, create a new one
            console.log("Adalo user not found, creating new user.");
            const createUserResponse = await fetch(adaloApiUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${ADALO_API_KEY}`
                },
                body: JSON.stringify({
                    'email': userInfo.email,
                    'name': userInfo.name || userInfo.given_name,
                    'google_id': userInfo.sub, // Google's unique user ID
                    'profile_picture': userInfo.picture // Example field
                    // Add other fields as needed based on your Adalo User collection
                })
            });

            if (!createUserResponse.ok) {
                const errorData = await createUserResponse.json();
                console.error("Error creating Adalo user:", errorData);
                throw new Error(`Failed to create Adalo user: ${errorData.message || createUserResponse.statusText}`);
            }
            const newUserData = await createUserResponse.json();
            adaloUserId = newUserData.id;
            console.log(`New Adalo user created: ${adaloUserId}`);
        }
        // --- End Example: Find or Create User ---

        // 4. Redirect back to Adalo, potentially logging the user in or passing user ID
        // You might need to configure Adalo to accept a user ID from the URL for login.
        // IMPORTANT: REPLACE 'https://your-adalo-app-domain.adalo.com' with your actual Adalo app domain
        return res.redirect(`https://your-adalo-app-domain.adalo.com/home?adalo_user_id=${adaloUserId}&google_auth_success=true`);

    } catch (error) {
        console.error("Error during Google OAuth process:", error);
        const errorMessage = encodeURIComponent(error.message || "An unknown error occurred during Google Auth.");
        // IMPORTANT: REPLACE 'https://your-adalo-app-domain.adalo.com' with your actual Adalo app domain
        return res.redirect(`https://your-adalo-app-domain.adalo.com/error-page?message=${errorMessage}`);
    }
});
