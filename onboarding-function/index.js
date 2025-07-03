const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');
const stripe = require('stripe'); // Stripe will be initialized with the secret key later

const secretManagerClient = new SecretManagerServiceClient();

// Function to securely get the Stripe Secret Key from Google Cloud Secret Manager
async function getStripeSecretKey() {
  const [version] = await secretManagerClient.accessSecretVersion({
    name: `projects/${process.env.GCP_PROJECT}/secrets/stripe-secret-key/versions/latest`,
  });
  return version.payload.data.toString('utf8');
}

let stripeInstance; // To store the initialized Stripe instance once retrieved

/**
 * HTTP Cloud Function to initiate the Stripe Connect onboarding process.
 * This function generates the Stripe OAuth URL that the user will be redirected to.
 *
 * @param {object} req Cloud Function request object.
 * @param {object} res Cloud Function response object.
 */
exports.stripeConnectOnboarding = async (req, res) => {
  // Set CORS headers to allow requests from your Adalo app
  res.set('Access-Control-Allow-Origin', '*'); // Consider restricting this to your Adalo domain in production
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight OPTIONS request (browser sends this before the actual request)
  if (req.method === 'OPTIONS') {
    res.status(204).send('');
    return;
  }

  try {
    // Initialize Stripe instance if not already initialized
    if (!stripeInstance) {
      const stripeSecretKey = await getStripeSecretKey();
      stripeInstance = stripe(stripeSecretKey);
    }

    // Get the userId from Adalo (passed as a query parameter or body parameter)
    // This userId helps you associate the connected Stripe account back to your Adalo user.
    const { userId } = req.query; // Assuming Adalo passes it as a query parameter

    if (!userId) {
      return res.status(400).send('Missing userId query parameter.');
    }

    // Construct the Stripe Connect OAuth URL
    // IMPORTANT:
    // - Replace `process.env.STRIPE_CLIENT_ID` with your actual Stripe Connect Client ID.
    // - Replace `process.env.STRIPE_REDIRECT_URI` with the URL of your deployed `stripeOAuthRedirect` function.
    // - `state` parameter is used by Stripe to return your `userId` back to your redirect function securely.
    const onboardingUrl = `https://connect.stripe.com/oauth/authorize?response_type=code&client_id=${process.env.STRIPE_CLIENT_ID}&scope=read_write&state=${userId}&redirect_uri=${process.env.STRIPE_REDIRECT_URI}`;

    // Respond with the onboarding URL. Adalo's Web View will then open this URL.
    res.status(200).send({ onboardingUrl });

  } catch (error) {
    console.error('Error in Stripe Connect onboarding function:', error);
    res.status(500).send(`Error: ${error.message}`);
  }
};

/**
 * HTTP Cloud Function to handle the redirect from Stripe after Connect OAuth.
 * Stripe sends the authorization `code` and your `state` (userId) to this function.
 *
 * @param {object} req Cloud Function request object.
 * @param {object} res Cloud Function response object.
 */
exports.stripeOAuthRedirect = async (req, res) => {
  // Set CORS headers
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).send('');
    return;
  }

  try {
    if (!stripeInstance) {
      const stripeSecretKey = await getStripeSecretKey();
      stripeInstance = stripe(stripeSecretKey);
    }

    // Extract 'code' and 'state' (which is our userId) from Stripe's redirect
    const { code, state: userId, error: stripeError } = req.query;

    // Handle any errors sent back by Stripe (e.g., user declined to connect)
    if (stripeError) {
      console.error('Stripe OAuth error:', stripeError);
      // Redirect back to Adalo with an error message
      // IMPORTANT: Replace `process.env.ADALO_APP_BASE_URL` with your actual Adalo app base URL
      return res.redirect(`${process.env.ADALO_APP_BASE_URL}/onboarding-failed?error=${stripeError}`);
    }

    if (!code || !userId) {
      return res.status(400).send('Missing code or state (userId) from Stripe redirect.');
    }

    // Exchange the authorization code for an access token (which contains the connected account ID)
    const response = await stripeInstance.oauth.token({
      grant_type: 'authorization_code',
      code: code,
    });

    const connectedAccountId = response.stripe_user_id; // This is the ID of the connected account!

    console.log(`User ${userId} successfully connected Stripe account: ${connectedAccountId}`);

    // --- IMPORTANT NEXT STEP ---
    // At this point, you MUST save `connectedAccountId` to your Adalo database,
    // associated with the `userId` that was just onboarded.
    //
    // Options to update Adalo:
    // 1. Direct Adalo API call (if you have Adalo's API key and can update user records):
    //    You'd make a `fetch` or `axios` POST/PUT request here to Adalo's API.
    // 2. Redirect back to Adalo with the ID in the URL:
    //    Adalo's screen would then read the URL parameter and use an internal Adalo action to save it.
    //    This example uses redirection, which is simpler for Adalo.

    // Redirect back to Adalo with the success message and connected account ID
    // IMPORTANT: Replace `process.env.ADALO_APP_BASE_URL` with your actual Adalo app base URL
    // (e.g., https://previewer.adalo.com/your-app-id or your custom domain)
    res.redirect(`${process.env.ADALO_APP_BASE_URL}/onboarding-success?accountId=${connectedAccountId}`);

  } catch (error) {
    console.error('Error handling Stripe OAuth redirect:', error);
    // Redirect back to Adalo with a generic error
    // IMPORTANT: Replace `process.env.ADALO_APP_BASE_URL` with your actual Adalo app base URL
    res.redirect(`${process.env.ADALO_APP_BASE_URL}/onboarding-failed?error=internal_server_error`);
  }
};