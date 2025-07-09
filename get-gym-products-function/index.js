const { Firestore } = require('@google-cloud/firestore');
const firestore = new Firestore(); // Initializes Firestore client

exports.getGymProducts = async (req, res) => { // <-- Note the camelCase here
  // Set CORS headers to allow requests from your Firebase Hosted shop.html
  // REPLACE THIS WITH YOUR ACTUAL FIREBASE HOSTING URL (e.g., https://your-project-id.web.app)
  res.set('Access-Control-Allow-Origin', 'https://activetopia-stripe-backe-9690d.web.app'); // <--- IMPORTANT: UPDATE THIS!
  res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).send('');
    return;
  }

  try {
    const { gymId } = req.query; // Expecting gymId as a query parameter from shop.html

    if (!gymId) {
      console.error('getGymProducts: Missing gymId query parameter.');
      return res.status(400).send({ error: 'Missing gymId query parameter.' });
    }

    // Query Firestore for products matching the gymId
    const productsRef = firestore.collection('gymProducts'); // Firestore collection name
    const snapshot = await productsRef.where('gymId', '==', gymId).get();

    if (snapshot.empty) {
      console.log(`getGymProducts: No products found for gymId: ${gymId}`);
      return res.status(200).json([]); // Return empty array if no products found
    }

    const products = [];
    snapshot.forEach(doc => {
      products.push({ id: doc.id, ...doc.data() });
    });

    res.status(200).json(products);

  } catch (error) {
    console.error('Error retrieving gym products:', error);
    // --- TEMPORARY: Return full error for debugging ---
    res.status(500).json({
      error: 'Failed to retrieve products.',
      details: error.message, // Send the error message
      stack: error.stack // Send the stack trace for full details
    });
    // --- END TEMPORARY ---
  }
};
