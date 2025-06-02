const express = require('express');
const bodyParser = require('body-parser');
const Razorpay = require('razorpay');
require('dotenv').config();

const app = express();
app.use(bodyParser.json());

// In-memory pricing (replace with DB or config for production)
let pricing = {
  basePrice: 199.00,
  discountPercentage: 0,
  lastUpdated: Date.now(),
};

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID, // rzp_test_Ds5xqQIv1RKQHb
  key_secret: process.env.RAZORPAY_KEY_SECRET // ba3od8fdWWrnL5SRRfcG35I4
});

// Fetch current pricing
app.get('/api/pricing', (req, res) => {
  const { basePrice, discountPercentage } = pricing;
  const finalPrice = (basePrice * (1 - discountPercentage / 100)).toFixed(2);
  res.json({
    success: true,
    data: {
      basePrice: basePrice.toFixed(2),
      discountPercentage: discountPercentage.toFixed(1),
      finalPrice,
      lastUpdated: pricing.lastUpdated,
    }
  });
});

// (Optional) Update pricing (for admin usage/testing)
app.post('/api/pricing', (req, res) => {
  const { basePrice, discountPercentage } = req.body;
  if (typeof basePrice !== 'number' || basePrice <= 0) {
    return res.status(400).json({ success: false, message: 'basePrice must be a positive number.' });
  }
  if (typeof discountPercentage !== 'number' || discountPercentage < 0 || discountPercentage > 100) {
    return res.status(400).json({ success: false, message: 'discountPercentage must be between 0 and 100.' });
  }
  pricing.basePrice = basePrice;
  pricing.discountPercentage = discountPercentage;
  pricing.lastUpdated = Date.now();
  res.json({ success: true, message: 'Pricing updated.', data: pricing });
});

// Razorpay order creation (auto-capture)
app.post('/api/razorpay/order', async (req, res) => {
  const { amount, currency } = req.body;
  if (!amount || !currency) {
    return res.status(400).json({ success: false, message: 'Amount and currency are required.' });
  }
  try {
    const order = await razorpay.orders.create({
      amount: parseInt(amount), // in paise
      currency: currency,
      receipt: `receipt_${Date.now()}`,
      payment_capture: 1
    });
    res.json({ success: true, orderId: order.id });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to create order.', error: err.message });
  }
});

app.listen(3000, () => console.log('Server running on port 3000'));
