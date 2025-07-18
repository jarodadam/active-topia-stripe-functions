// functions/getgymproducts/index.js
// This file contains the Cloud Function for retrieving gym products from Firestore.

// --- REQUIRED MODULE IMPORTS FOR THIS FUNCTION ---
const functions = require('firebase-functions');
const admin = require('firebase-admin'); // Required for initializing Firebase Admin SDK
const { Firestore } = require('@google-cloud/firestore'); // Required for Firestore client

// --- Initialize Firebase Admin SDK (must be called only once per function instance) ---
admin.initializeApp();
const db = new Firestore({
    databaseId: '(default)' // This is the correct Database ID to use
});


// --- getGymProducts Function Definition ---
exports.getGymProducts = functions.https.onRequest(async (req, res) => {
    // Set CORS headers to allow requests from your Firebase Hosted shop.html
    // IMPORTANT: REPLACE 'YOUR_FIREBASE_HOSTING_URL' with your actual Firebase Hosting URL (e.g., https://your-project-id.web.app)
    res.set('Access-Control-Allow-Origin', 'https://activetopia-stripe-backe-9690d.web.app'); // Using the provided URL
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
