const service = 'mizani-config';
const version = '0.1.0';
const PAYMENT_LOG_ADDRESS = process.env.PAYMENT_LOG_ADDRESS;
const FUJI_RPC_URL = process.env.FUJI_RPC_URL;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const FUJI_EXPLORER_URL = process.env.FUJI_EXPLORER_URL || 'https://testnet.snowtrace.io';

export default async function(req, res) {
  return res.json({
    service,
    version,
    paymentLogAddress: PAYMENT_LOG_ADDRESS || null,
    fujiRpcConfigured: Boolean(FUJI_RPC_URL),
    geminiConfigured: Boolean(GEMINI_API_KEY),
    snowtraceBaseUrl: FUJI_EXPLORER_URL,
    contractExplorerUrl: PAYMENT_LOG_ADDRESS ? `${FUJI_EXPLORER_URL}/address/${PAYMENT_LOG_ADDRESS}` : null,
  });
}