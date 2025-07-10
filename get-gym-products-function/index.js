const { Firestore } = require('@google-cloud/firestore');

// Explicitly connect to the default Firestore database
const firestore = new Firestore({
  databaseId: '(default)' // This is the correct Database ID to use
});

exports.getGymProducts = async (req, res) => {
  // Set CORS headers to allow requests from your Firebase Hosted shop.html
  // REPLACE THIS WITH YOUR ACTUAL FIREBASE HOSTING URL (e.g., https://your-project-id.web.app)
  res.set('Access-Control-Allow-Origin', 'https://activetopia-stripe-backe-9690d.web.app'); // <--- UPDATED!
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
    // Clean, production-ready error response
    res.status(500).send({ error: 'Failed to retrieve products.' });
  }
};