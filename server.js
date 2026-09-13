/**
 * Payment registration + OTP verification backend.
 *
 * Flow:
 *   POST /api/register-payment  -> creates a transaction, generates a 6-digit
 *                                  OTP, emails it, and (optionally) sends it
 *                                  to your Telegram chat. Returns a transactionId.
 *   POST /api/verify-otp        -> checks the code against what was generated,
 *                                  respecting a 5-minute expiry and a max of
 *                                  5 attempts.
 *
 * The OTP is generated and checked here on the server only - it is never
 * trusted from the client.
 */

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// --- In-memory store (swap for Supabase/Postgres/Redis in production) ---
// Map<transactionId, { code, email, expiresAt, attempts, data }>
const transactions = new Map();

const OTP_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_ATTEMPTS = 5;

function generateOtp() {
  // 6-digit numeric code, cryptographically random
  return crypto.randomInt(100000, 1000000).toString();
}

// --- Email transport (SMTP - works with Gmail, Zoho, SendGrid SMTP, etc.) ---
const mailer = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: Number(process.env.SMTP_PORT) === 465,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

async function sendOtpEmail(toEmail, code, payload) {
  await mailer.sendMail({
    from: process.env.MAIL_FROM || process.env.SMTP_USER,
    to: toEmail,
    subject: 'Your payment verification code',
    text: `Your code is ${code}. It expires in 5 minutes.\n\nTracking: ${payload.tracking}\nAmount: ${payload.amount} ${payload.currency}`,
    html: `<p>Your verification code is:</p><h2 style="letter-spacing:4px">${code}</h2><p>Expires in 5 minutes.</p><p>Tracking: ${payload.tracking}<br>Amount: ${payload.amount} ${payload.currency}</p>`
  });
}

// --- Telegram (optional) ---
async function sendOtpTelegram(code, payload) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return; // Telegram not configured, skip silently

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const text = `🔐 New payment code: ${code}\nTracking: ${payload.tracking}\nAmount: ${payload.amount} ${payload.currency}\nExpires in 5 min.`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text })
  });
  if (!res.ok) {
    console.error('Telegram send failed:', await res.text());
  }
}

// --- Routes ---

app.get('/', (req, res) => {
  res.json({ ok: true, message: 'OTP backend is running. Use POST /api/register-payment and POST /api/verify-otp.' });
});

app.post('/api/register-payment', async (req, res) => {
  try {
    const { tracking, mode, accountName, accountNumber, amount, currency, email } = req.body;

    if (!tracking || !mode || !accountName || !accountNumber || !amount || !currency || !email) {
      return res.status(400).json({ ok: false, error: 'Missing required fields' });
    }

    const transactionId = crypto.randomUUID();
    const code = generateOtp();

    transactions.set(transactionId, {
      code,
      email,
      expiresAt: Date.now() + OTP_TTL_MS,
      attempts: 0,
      data: { tracking, mode, accountName, accountNumber, amount, currency }
    });

    await sendOtpEmail(email, code, { tracking, amount, currency });
    await sendOtpTelegram(code, { tracking, amount, currency });

    res.json({ ok: true, transactionId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message || 'Failed to register payment' });
  }
});

app.post('/api/verify-otp', (req, res) => {
  const { transactionId, code } = req.body;
  const tx = transactions.get(transactionId);

  if (!tx) {
    return res.status(404).json({ ok: false, error: 'Transaction not found' });
  }
  if (Date.now() > tx.expiresAt) {
    transactions.delete(transactionId);
    return res.status(410).json({ ok: false, error: 'Code expired, please register again' });
  }
  if (tx.attempts >= MAX_ATTEMPTS) {
    transactions.delete(transactionId);
    return res.status(429).json({ ok: false, error: 'Too many attempts' });
  }

  tx.attempts += 1;

  if (code !== tx.code) {
    return res.status(400).json({ ok: false, error: 'Incorrect code' });
  }

  transactions.delete(transactionId); // one-time use
  res.json({ ok: true, message: 'Payment verified', transaction: tx.data });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`OTP backend running on http://localhost:${PORT}`));