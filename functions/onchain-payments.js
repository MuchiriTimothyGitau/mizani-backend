import { ethers } from 'ethers';

const service = 'mizani-onchain-payments';
const version = '0.1.0';
const PAYMENT_LOG_ADDRESS = process.env.PAYMENT_LOG_ADDRESS;
const FUJI_RPC_URL = process.env.FUJI_RPC_URL;
const FUJI_EXPLORER_URL = process.env.FUJI_EXPLORER_URL || 'https://testnet.snowtrace.io';
const MAX_PAYMENTS = 100;

function sanitizeErrorMessage(message) {
  if (!message) return 'Chain data fetch failed';
  if (typeof message !== 'string') return 'Chain data fetch failed';
  const trimmed = message.trim();
  if (!trimmed) return 'Chain data fetch failed';
  return trimmed.length > 200 ? trimmed.slice(0, 200) + '...' : trimmed;
}

function parsePaymentLogConfig() {
  const abi = [
    "event PaymentRecorded(address indexed sender, string label, uint256 amount, uint256 recordedAt)",
    "function recordPayment(string label, uint256 amount) external"
  ];
  const validAddress = typeof PAYMENT_LOG_ADDRESS === "string" && /^0x[a-fA-F0-9]{40}$/.test(PAYMENT_LOG_ADDRESS);
  return {
    address: validAddress ? PAYMENT_LOG_ADDRESS : null,
    abi,
    explorerUrl: FUJI_EXPLORER_URL,
    contractExplorerUrl: validAddress ? `${FUJI_EXPLORER_URL}/address/${PAYMENT_LOG_ADDRESS}` : null,
  };
}

export default async function(req, res) {
  try {
    const config = parsePaymentLogConfig();
    
    if (!config.address || !FUJI_RPC_URL) {
      return res.json({ service, version, payments: [], paymentLogAddress: null, contractExplorerUrl: null });
    }

    const provider = new ethers.JsonRpcProvider(FUJI_RPC_URL);
    const contract = new ethers.Contract(config.address, config.abi, provider);
    const currentBlock = await provider.getBlockNumber();
    const fromBlock = Math.max(0, currentBlock - 500);
    const filter = contract.filters.PaymentRecorded();
    const events = await contract.queryFilter(filter, fromBlock, "latest");

    const payments = events
      .map((event) => ({
        label: event.args.label,
        amount: ethers.formatEther(event.args.amount),
        sender: event.args.sender,
        blockNumber: event.blockNumber,
        transactionHash: event.transactionHash,
        timestamp: event.blockTimestamp || event.args.recordedAt?.toString() || null,
        explorerUrl: `${config.explorerUrl}/tx/${event.transactionHash}`,
      }))
      .reverse()
      .slice(0, MAX_PAYMENTS);

    return res.json({ service, version, paymentLogAddress: config.address, payments, contractExplorerUrl: config.contractExplorerUrl });
  } catch (err) {
    return res.json({ service, version, ok: false, error: sanitizeErrorMessage(err.message) }, 500);
  }
}