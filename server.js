import fs from 'node:fs';
import path from 'node:path';
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { ethers } from 'ethers';
import { scoreTransactions } from './src/scorer.js';

const app = express();
const port = process.env.PORT || 5000;
const service = 'mizani-backend';
const version = process.env.npm_package_version || '0.1.0';
const maxTransactions = 2000;
const maxOnChainPayments = 100;
const maxAmount = 1_000_000_000;
const maxLabelLength = 120;
const allowedOrigins = process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',').map((origin) => origin.trim()) : ['http://localhost:5173'];
const fujiExplorerUrl = process.env.FUJI_EXPLORER_URL || 'https://testnet.snowtrace.io';

function parseNumber(value) {
  if (value === undefined || value === null || value === '') return NaN;
  return Number(String(value).replace(/,/g, '').trim());
}

function sanitizeAmount(value, fieldName = 'amount') {
  const amount = parseNumber(value);
  if (!Number.isFinite(amount)) throw new Error(`${fieldName} must be a number`);
  if (Math.abs(amount) > maxAmount) throw new Error(`${fieldName} is outside the allowed range`);
  return Number(amount.toFixed(2));
}

function sanitizeLabel(value) {
  const label = String(value || '').trim().slice(0, maxLabelLength);
  if (!label) throw new Error('label is required');
  return label;
}

function sanitizeTransactions(input) {
  if (!Array.isArray(input)) throw new Error('transactions must be an array');
  if (input.length > maxTransactions) throw new Error(`transactions must contain ${maxTransactions} rows or fewer`);

  return input.map((row, index) => ({
    date: String(row?.date || '').slice(0, 32),
    description: sanitizeLabel(row?.description || row?.Narration || row?.narration || row?.Details || row?.details || `Row ${index + 1}`),
    amount: sanitizeAmount(row?.amount ?? row?.Amount ?? row?.Debit ?? row?.Credit ?? row?.['Debit / Credit'], `transactions[${index}].amount`),
    balance: row?.balance === undefined || row?.balance === null || row?.balance === '' ? null : sanitizeAmount(row.balance, `transactions[${index}].balance`),
  }));
}

function sanitizeOnChainPayments(input) {
  if (!Array.isArray(input)) return [];
  return input.slice(0, maxOnChainPayments).map((payment, index) => ({
    label: sanitizeLabel(payment?.label || `On-chain payment ${index + 1}`),
    amount: sanitizeAmount(payment?.amount || 0, `onChainPayments[${index}].amount`),
  }));
}

function safeScoreForReport(score) {
  const { transactions, ...safe } = score || {};
  return safe;
}

function loadContractConfig() {
  const deploymentPath = path.join(process.cwd(), 'deployments', 'PaymentLog.json');
  const fileConfig = fs.existsSync(deploymentPath) ? JSON.parse(fs.readFileSync(deploymentPath, 'utf8')) : {};
  const address = process.env.PAYMENT_LOG_ADDRESS || fileConfig.address;
  const abi = Array.isArray(fileConfig.abi) ? fileConfig.abi : [];
  const validAddress = typeof address === 'string' && /^0x[a-fA-F0-9]{40}$/.test(address);
  return {
    address: validAddress ? address : null,
    abi,
    explorerUrl: fujiExplorerUrl,
    contractExplorerUrl: validAddress ? `${fujiExplorerUrl}/address/${address}` : null,
  };
}

function sendError(res, statusCode, message, code = 'REQUEST_FAILED') {
  res.status(statusCode).json({ error: { code, message } });
}

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

const reportLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error('Blocked by CORS'));
  },
}));
app.use(express.json({ limit: '1mb' }));
app.use(apiLimiter);

app.get('/health', (req, res) => {
  res.json({ ok: true, service, version, timestamp: new Date().toISOString() });
});

app.get('/config', (req, res) => {
  const config = loadContractConfig();
  res.json({
    service,
    version,
    paymentLogAddress: config.address,
    fujiRpcConfigured: Boolean(process.env.FUJI_RPC_URL),
    geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
    snowtraceBaseUrl: fujiExplorerUrl,
    contractExplorerUrl: config.contractExplorerUrl,
  });
});

app.post('/score', (req, res) => {
  try {
    const transactions = sanitizeTransactions(req.body?.transactions);
    const onChainPayments = sanitizeOnChainPayments(req.body?.onChainPayments);
    const result = scoreTransactions(transactions, onChainPayments);
    res.json({ service, version, ...result });
  } catch (err) {
    sendError(res, 400, err.message, 'INVALID_SCORE_PAYLOAD');
  }
});

app.post('/report', reportLimiter, async (req, res) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY is not configured');
    const safeScore = safeScoreForReport(req.body?.score);

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text: `You are a financial controller writing for a Kenyan startup or SME founder. Use only the scored cash-flow data below. Be specific, cite the numbers, flag the riskiest item first, and keep it concise.

Scored data:
${JSON.stringify(safeScore, null, 2)}

Return a practical note with:
1. One short overall financial health assessment.
2. The top cash-flow risk.
3. What management should investigate or change this week.
4. Three metrics to track next month.
5. Any numbers that may be misleading because this MVP uses a simulated CSV instead of a live Zoho connection.`,
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 900,
        },
      }),
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'Gemini report failed');
    const text = data.candidates?.[0]?.content?.parts?.map((part) => part.text).join('\n') || '';
    res.json({ service, version, report: text, generatedAt: new Date().toISOString() });
  } catch (err) {
    sendError(res, 500, err.message, 'REPORT_FAILED');
  }
});

app.get('/onchain-payments', async (req, res) => {
  try {
    const { address, abi, explorerUrl, contractExplorerUrl } = loadContractConfig();
    if (!address || !process.env.FUJI_RPC_URL || abi.length === 0) {
      return res.json({ service, version, payments: [], contractExplorerUrl });
    }

    const provider = new ethers.JsonRpcProvider(process.env.FUJI_RPC_URL);
    const contract = new ethers.Contract(address, abi, provider);
    const currentBlock = await provider.getBlockNumber();
    const fromBlock = Math.max(0, currentBlock - 500);
    const filter = contract.filters.PaymentRecorded();
    const events = await contract.queryFilter(filter, fromBlock, 'latest');

    const payments = events
      .map((event) => ({
        label: event.args.label,
        amount: ethers.formatEther(event.args.amount),
        sender: event.args.sender,
        blockNumber: event.blockNumber,
        transactionHash: event.transactionHash,
        timestamp: event.blockTimestamp || event.args.recordedAt?.toString() || null,
        explorerUrl: `${explorerUrl}/tx/${event.transactionHash}`,
      }))
      .reverse();

    res.json({ service, version, payments, contractExplorerUrl });
  } catch (err) {
    sendError(res, 500, err.message, 'CHAIN_READ_FAILED');
  }
});

app.listen(port, () => {
  console.log(`${service} v${version} listening on ${port}`);
});
