const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { createClient } = require('@libsql/client');
const Razorpay = require('razorpay');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const PORT = 3000;

// Initialize Turso client
const client = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// Initialize Razorpay client
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// Middleware
app.use(cors());
app.use(bodyParser.json());

// Initialize database tables
async function initializeDatabase() {
  try {
    // Create payments table with paymentId and orderId
    await client.execute(`
      CREATE TABLE IF NOT EXISTS payments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fullName TEXT NOT NULL,
        phone TEXT NOT NULL,
        email TEXT NOT NULL,
        paymentId TEXT,
        orderId TEXT,
        amount TEXT NOT NULL,
        basePrice REAL NOT NULL,
        discountPercentage REAL NOT NULL,
        status TEXT NOT NULL,
        date INTEGER NOT NULL
      )
    `);

    // Create pricing table (removed upiId)
    await client.execute(`
      CREATE TABLE IF NOT EXISTS pricing (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        basePrice REAL NOT NULL,
        discountPercentage REAL NOT NULL,
        lastUpdated INTEGER NOT NULL
      )
    `);

    // Insert default pricing if table is empty (₹199 with 85% discount)
    const result = await client.execute('SELECT COUNT(*) as count FROM pricing');
    if (result.rows[0].count === 0) {
      await client.execute({
        sql: 'INSERT INTO pricing (basePrice, discountPercentage, lastUpdated) VALUES (?, ?, ?)',
        args: [199.00, 85.0, Date.now()],
      });
      console.log('Default pricing initialized: ₹199, 85% discount');
    }

    console.log('Database tables ready.');
  } catch (err) {
    console.error('Failed to initialize database:', err.message);
    process.exit(1);
  }
}

// Call the initialization function
initializeDatabase();

// Basic input sanitization
const sanitizeString = (str) => {
  if (typeof str !== 'string') return '';
  return str.trim().replace(/[^a-zA-Z0-9@._-]/g, '');
};

// GET endpoint to fetch pricing details
app.get('/api/pricing', async (req, res) => {
  try {
    const result = await client.execute('SELECT * FROM pricing LIMIT 1');
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'No pricing data found.' });
    }

    const { basePrice, discountPercentage } = result.rows[0];
    const finalPrice = (basePrice * (1 - discountPercentage / 100)).toFixed(2);

    res.json({
      success: true,
      data: {
        basePrice: parseFloat(basePrice).toFixed(2),
        discountPercentage: parseFloat(discountPercentage).toFixed(1),
        finalPrice,
      },
    });
  } catch (err) {
    console.error('Error fetching pricing:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch pricing.' });
  }
});

// POST endpoint to update pricing details
app.post('/api/pricing', async (req, res) => {
  const { basePrice, discountPercentage } = req.body;

  // Validate request body
  if (!basePrice || !discountPercentage) {
    return res.status(400).json({ success: false, message: 'basePrice and discountPercentage are required.' });
  }

  // Validate numeric values
  const basePriceNum = parseFloat(basePrice);
  const discountPercentageNum = parseFloat(discountPercentage);
  if (isNaN(basePriceNum) || basePriceNum <= 0) {
    return res.status(400).json({ success: false, message: 'basePrice must be a positive number.' });
  }
  if (isNaN(discountPercentageNum) || discountPercentageNum < 0 || discountPercentageNum > 100) {
    return res.status(400).json({ success: false, message: 'discountPercentage must be between 0 and 100.' });
  }

  try {
    // Update pricing table
    const result = await client.execute({
      sql: 'UPDATE pricing SET basePrice = ?, discountPercentage = ?, lastUpdated = ? WHERE id = 1',
      args: [basePriceNum, discountPercentageNum, Date.now()],
    });

    if (result.rowsAffected === 0) {
      return res.status(404).json({ success: false, message: 'No pricing record found to update.' });
    }

    const finalPrice = (basePriceNum * (1 - discountPercentageNum / 100)).toFixed(2);
    res.json({
      success: true,
      message: 'Pricing updated successfully.',
      data: {
        basePrice: basePriceNum.toFixed(2),
        discountPercentage: discountPercentageNum.toFixed(1),
        finalPrice,
      },
    });
  } catch (err) {
    console.error('Error updating pricing:', err.message);
    res.status(500).json({ success: false, message: 'Failed to update pricing.' });
  }
});

// POST endpoint to create Razorpay order
app.post('/api/razorpay/order', async (req, res) => {
  const { amount, currency } = req.body;

  if (!amount || !currency) {
    return res.status(400).json({ success: false, message: 'Amount and currency are required.' });
  }

  const amountNum = parseInt(amount);
  if (isNaN(amountNum) || amountNum <= 0) {
    return res.status(400).json({ success: false, message: 'Amount must be a positive integer.' });
  }

  try {
    const order = await razorpay.orders.create({
      amount: amountNum,
      currency: currency,
      receipt: `receipt_${Date.now()}`,
    });
    res.json({ success: true, orderId: order.id });
  } catch (err) {
    console.error('Error creating Razorpay order:', err); // Log full error object
    res.status(500).json({ success: false, message: 'Failed to create order.', error: err.message, details: err });
  }
});

// POST endpoint to save payment details
app.post('/api/payment', async (req, res) => {
  const { fullName, phone, email, paymentId, orderId, amount, status, date } = req.body;

  // Validate request body
  if (!fullName || !phone || !email || !amount || !status || !date || !orderId) {
    return res.status(400).json({ success: false, message: 'Missing required fields.' });
  }

  // Sanitize inputs
  const sanitizedFullName = sanitizeString(fullName);
  const sanitizedPhone = sanitizeString(phone);
  const sanitizedEmail = sanitizeString(email);
  const sanitizedPaymentId = paymentId ? sanitizeString(paymentId) : '';
  const sanitizedOrderId = sanitizeString(orderId);

  // Validate phone (10 digits)
  const phoneRegex = /^\d{10}$/;
  if (!phoneRegex.test(sanitizedPhone)) {
    return res.status(400).json({ success: false, message: 'Phone number must be 10 digits.' });
  }

  // Validate email
  const emailRegex = /^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  if (!emailRegex.test(sanitizedEmail)) {
    return res.status(400).json({ success: false, message: 'Invalid email format.' });
  }

  // Validate status
  const validStatuses = ['pending', 'success', 'failed'];
  if (!validStatuses.includes(status.toLowerCase())) {
    return res.status(400).json({ success: false, message: 'Invalid status. Must be pending, success, or failed.' });
  }

  try {
    // Fetch current pricing to validate and store
    const pricingResult = await client.execute('SELECT basePrice, discountPercentage FROM pricing LIMIT 1');
    if (pricingResult.rows.length === 0) {
      return res.status(400).json({ success: false, message: 'No pricing data available.' });
    }

    const { basePrice, discountPercentage } = pricingResult.rows[0];
    const expectedFinalPrice = (basePrice * (1 - discountPercentage / 100)).toFixed(2);

    // Validate the amount sent from the client
    if (parseFloat(amount).toFixed(2) !== expectedFinalPrice) {
      return res.status(400).json({ success: false, message: `Invalid amount. Expected ${expectedFinalPrice}, received ${amount}.` });
    }

    // Verify Razorpay payment (if paymentId is provided)
    if (paymentId && status.toLowerCase() === 'success') {
      try {
        const payment = await razorpay.payments.fetch(paymentId);
        if (payment.order_id !== orderId || payment.status !== 'captured') {
          return res.status(400).json({ success: false, message: 'Invalid payment or order ID.' });
        }
        // Optionally verify payment signature
        const generatedSignature = crypto
          .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
          .update(`${orderId}|${paymentId}`)
          .digest('hex');
        // You can receive the signature from the client if needed
      } catch (err) {
        console.error('Error verifying Razorpay payment:', err.message);
        return res.status(400).json({ success: false, message: 'Payment verification failed.' });
      }
    }

    // Insert payment details into the Turso database
    await client.execute({
      sql: 'INSERT INTO payments (fullName, phone, email, paymentId, orderId, amount, basePrice, discountPercentage, status, date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      args: [sanitizedFullName, sanitizedPhone, sanitizedEmail, sanitizedPaymentId, sanitizedOrderId, amount, basePrice, discountPercentage, status, date],
    });

    res.json({ success: true, message: 'Payment saved.' });
  } catch (err) {
    console.error('Error saving payment:', err.message);
    res.status(500).json({ success: false, message: 'Failed to save payment.' });
  }
});

// PATCH endpoint to update payment status
app.patch('/api/payment/:id', async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  // Validate request body
  if (!status) {
    return res.status(400).json({ success: false, message: 'Status is required.' });
  }

  // Validate status
  const validStatuses = ['pending', 'success', 'failed'];
  if (!validStatuses.includes(status.toLowerCase())) {
    return res.status(400).json({ success: false, message: 'Invalid status. Must be pending, success, or failed.' });
  }

  try {
    const result = await client.execute({
      sql: 'UPDATE payments SET status = ? WHERE id = ?',
      args: [status.toLowerCase(), id],
    });

    if (result.rowsAffected === 0) {
      return res.status(404).json({ success: false, message: 'Payment record not found.' });
    }

    res.json({ success: true, message: 'Payment status updated.' });
  } catch (err) {
    console.error('Error updating payment status:', err.message);
    res.status(500).json({ success: false, message: 'Failed to update payment status.' });
  }
});

// GET endpoint to retrieve all payments
app.get('/api/payments', async (req, res) => {
  try {
    const result = await client.execute('SELECT * FROM payments ORDER BY date DESC');
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error('Error fetching payments:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch payments.' });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unexpected error:', err.message);
  res.status(500).json({ success: false, message: 'Internal server error.' });
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

// Gracefully close the database connection on server shutdown
process.on('SIGTERM', async () => {
  console.log('Shutting down server...');
  await client.close();
  process.exit(0);
});
