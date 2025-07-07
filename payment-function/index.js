const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');
const stripe = require('stripe');

const secretManagerClient = new SecretManagerServiceClient();

// Function to securely get the Stripe Secret Key from Google Cloud Secret Manager
async function getStripeSecretKey() {
  const secretPath = `projects/${process.env.GCP_PROJECT}/secrets/stripe-secret-key/versions/latest`;

  // Temporary log to see the exact path being accessed (REMOVE THIS LINE LATER AFTER DEBUGGING)
  console.log(`Attempting to access secret at: ${secretPath}`);

  try {
    const [version] = await secretManagerClient.accessSecretVersion({
      name: secretPath, // Use the defined secretPath variable
    });
    return version.payload.data.toString('utf8');
  } catch (error) {
    console.error(`Error accessing secret in getStripeSecretKey: ${error.message}`);
    throw new Error(`Failed to retrieve Stripe Secret Key: ${error.message}`);
  }
}

let stripeInstance; // To store the initialized Stripe instance once retrieved

/**
 * HTTP Cloud Function to process a payment from a buyer to a connected Stripe account,
 * while taking an application fee for the platform.
 *
 * @param {object} req Cloud Function request object.
 * @param {object} res Cloud Function response object.
 */
exports.processConnectPayment = async (req, res) => {
  // Set CORS headers to allow requests from your Adalo app
  res.set('Access-Control-Allow-Origin', '*'); // Consider restricting this to your Adalo domain in production
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight OPTIONS request
  if (req.method === 'OPTIONS') {
    res.status(204).send('');
    return;
  }

  try {
    // Extract raw values from the request body
    const {
      amount: rawAmount,
      currency,
      paymentMethodId,
      connectedAccountId,
      applicationFeeAmount: rawApplicationFeeAmount
    } = req.body;

    // --- Robust explicit conversion and validation ---
    // Convert amount and applicationFeeAmount to numbers
    const amount = parseInt(rawAmount, 10);
    const applicationFeeAmount = parseInt(rawApplicationFeeAmount, 10);

    // Debug logs (REMOVE THESE LINES AFTER SUCCESSFUL DEPLOYMENT AND TESTING)
    console.log(`Received rawAmount: ${rawAmount}, type: ${typeof rawAmount}`);
    console.log(`Received amount (converted): ${amount}, type: ${typeof amount}`);
    console.log(`Received rawApplicationFeeAmount: ${rawApplicationFeeAmount}, type: ${typeof rawApplicationFeeAmount}`);
    console.log(`Received applicationFeeAmount (converted): ${applicationFeeAmount}, type: ${typeof applicationFeeAmount}`);
    console.log(`Using paymentMethodId: ${paymentMethodId}`);
    console.log(`Using connectedAccountId: ${connectedAccountId}`);
    console.log(`Using currency: ${currency}`);
    // --- END DEBUG LOGS ---

    // Initialize Stripe instance if not already initialized
    if (!stripeInstance) {
      const stripeSecretKey = await getStripeSecretKey();
      stripeInstance = stripe(stripeSecretKey);
    }

    // --- RESTORED VALIDATION CHECKS ---
    // Validate if conversion resulted in NaN or if required parameters are missing
    if (isNaN(amount) || isNaN(applicationFeeAmount) || !currency || !paymentMethodId || !connectedAccountId || applicationFeeAmount === undefined) {
      console.error('Validation Error: Missing or invalid required payment parameters.');
      return res.status(400).send({ error: 'Missing or invalid required payment parameters. Ensure amount, currency, paymentMethodId, connectedAccountId, and applicationFeeAmount are provided and valid numbers.' });
    }

    // Validate numerical values
    if (amount <= 0 || applicationFeeAmount < 0) {
        console.error('Validation Error: Amount must be positive, applicationFeeAmount cannot be negative.');
        return res.status(400).send({ error: 'Amount must be positive, applicationFeeAmount cannot be negative.' });
    }
    if (applicationFeeAmount > amount) {
        console.error('Validation Error: Application fee cannot be greater than the total amount.');
        return res.status(400).send({ error: 'Application fee cannot be greater than the total amount.' });
    }
    // --- END RESTORED VALIDATION CHECKS ---


    // Create a Payment Intent on your platform account
    // This uses the 'Separate Charges and Transfers' model, offering maximum control.
    // The amount is charged to the buyer, then funds are transferred to the connected account,
    // and your platform's application fee is taken.
    const paymentIntent = await stripeInstance.paymentIntents.create({
      amount: amount,                 // Total amount to charge the buyer
      currency: currency,
      payment_method: paymentMethodId,  // The payment method collected via Stripe.js
      confirm: true,                  // Confirm the payment immediately
      application_fee_amount: applicationFeeAmount, // Your platform's cut
      transfer_data: {
        destination: connectedAccountId, // The service provider's Stripe account
      },
      automatic_payment_methods: {
        enabled: true,
        allow_redirects: 'never' // This tells Stripe not to try redirecting for this PaymentIntent
      }
    });

    // Respond to Adalo with success or failure details
    res.status(200).send({
      success: true,
      paymentIntentId: paymentIntent.id,
      status: paymentIntent.status,
      // You can send back any additional data Adalo needs for tracking or display
    });

  } catch (error) {
    console.error('Error processing Stripe Connect payment:', error);
    // Return a structured error response to Adalo
    res.status(500).send({
      success: false,
      error: error.message,
      stripeErrorCode: error.code, // Stripe-specific error code for debugging
      // Add other relevant error details if needed
    });
  }
};


// --- Optional: Webhook Handler Function (for real-time updates from Stripe) ---
// You would deploy this as a separate Cloud Function or as another entry point
// within this same function file if you configure it that way in GCP.
// If you put it in this file, you'd deploy it as `exports.stripeWebhookHandler`

/**
 * HTTP Cloud Function to handle Stripe Webhook events.
 * This function receives real-time updates from Stripe about various events
 * (e.g., successful payments, refunds, account updates).
 *
 * @param {object} req Cloud Function request object.
 * @param {object} res Cloud Function response object.
 */
/*
exports.stripeWebhookHandler = async (req, res) => {
    // Set CORS headers (less critical for webhooks, but good for consistency)
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Stripe-Signature');

    if (req.method === 'OPTIONS') {
        res.status(204).send('');
        return;
    }

    if (!stripeInstance) {
        const stripeSecretKey = await getStripeSecretKey();
        stripeInstance = stripe(stripeSecretKey);
    }

    const sig = req.headers['stripe-signature'];
    let event;

    try {
        // CRITICAL: Verify the webhook signature to ensure the event is from Stripe
        // IMPORTANT: Replace 'whsec_YOUR_WEBHOOK_SECRET' with your actual webhook secret
        // You get this secret from Stripe when you create the webhook endpoint in your Stripe Dashboard.
        event = stripeInstance.webhooks.constructEvent(req.rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        console.error(`Webhook signature verification failed: ${err.message}`);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Handle the event based on its type
    switch (event.type) {
        case 'payment_intent.succeeded':
            const paymentIntentSucceeded = event.data.object;
            console.log(`PaymentIntent ${paymentIntentSucceeded.id} succeeded for connected account ${paymentIntentSucceeded.transfer_data.destination}`);
            // TODO: Update your Adalo database (e.g., mark booking as paid, update internal records).
            // This would likely involve making an API call back to Adalo's API if they expose it
            // for external updates, or to your own Google Cloud Firestore database.
            break;
        case 'charge.refunded':
            const chargeRefunded = event.data.object;
            console.log(`Charge ${chargeRefunded.id} refunded.`);
            // TODO: Update Adalo database to reflect the refund.
            break;
        case 'connect.account.updated':
            const connectedAccount = event.data.object;
            console.log(`Connected account ${connectedAccount.id} updated. Charges enabled: ${connectedAccount.charges_enabled}`);
            // TODO: Update Adalo database for the service provider (e.g., set them as 'active' if `charges_enabled` is true).
            break;
        case 'payment_intent.payment_failed':
            const paymentIntentFailed = event.data.object;
            console.error(`PaymentIntent ${paymentIntentFailed.id} failed. Reason: ${paymentIntentFailed.last_payment_error?.message}`);
            // TODO: Update Adalo database to reflect the payment failure.
            break;
        // Add more event types as needed based on your application's requirements
        default:
            console.log(`Unhandled event type ${event.type}`);
    }

    // Return a 200 response to acknowledge receipt of the event.
    // Stripe will retry sending the webhook if it doesn't receive a 2xx response.
    res.status(200).json({ received: true });
};
*/
