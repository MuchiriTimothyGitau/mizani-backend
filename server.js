import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import cors from 'cors';
import { ethers } from 'ethers';
import { scoreTransactions } from './src/scorer.js';

const app = express();
const port = process.env.PORT || 5000;

app.use(cors());
app.use(express.json({ limit: '2mb' }));

function loadContractConfig() {
  const deploymentPath = path.join(process.cwd(), 'deployments', 'PaymentLog.json');
  const fileConfig = fs.existsSync(deploymentPath) ? JSON.parse(fs.readFileSync(deploymentPath, 'utf8')) : {};
  return {
    address: process.env.PAYMENT_LOG_ADDRESS || fileConfig.address,
    abi: fileConfig.abi || [],
  };
}

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.post('/score', (req, res) => {
  try {
    const transactions = Array.isArray(req.body?.transactions) ? req.body.transactions : [];
    const onChainPayments = Array.isArray(req.body?.onChainPayments) ? req.body.onChainPayments : [];
    const result = scoreTransactions(transactions, onChainPayments);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/report', async (req, res) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY is not configured');

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text: `You are a financial controller writing for a Kenyan SME founder. Use the scored cash-flow data below. Be specific, cite the numbers, flag the riskiest item first, and keep it concise.

Scored data:
${JSON.stringify(req.body?.score || {}, null, 2)}

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
    res.json({ report: text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/onchain-payments', async (req, res) => {
  try {
    const { address, abi } = loadContractConfig();
    if (!address || !process.env.FUJI_RPC_URL || abi.length === 0) {
      return res.json({ payments: [] });
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
        timestamp: event.blockTimestamp,
      }))
      .reverse();

    res.json({ payments });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(port, () => {
  console.log(`Mizani backend listening on ${port}`);
});
