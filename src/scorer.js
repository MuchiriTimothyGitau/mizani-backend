const MONTHS = 3;
const RUNWAY_WARNING_MONTHS = 3;
const ROUND_WITHDRAWAL_THRESHOLD = 0.2;

function parseAmount(value) {
  if (value === undefined || value === null || value === '') return NaN;
  return Number(String(value).replace(/,/g, '').trim());
}

function parseDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function monthsBetween(startDate, endDate) {
  if (!startDate || !endDate) return MONTHS;
  const diffMs = endDate.getTime() - startDate.getTime();
  const diffMonths = diffMs / (1000 * 60 * 60 * 24 * 30.4375);
  return Math.max(1, diffMonths);
}

function isRoundWithdrawal(amount) {
  return amount < 0 && Math.abs(amount) >= 1000 && Math.abs(amount) % 1000 === 0;
}

export function scoreTransactions(transactions, onChainPayments = []) {
  if (!Array.isArray(transactions) || transactions.length === 0) {
    throw new Error('transactions must be a non-empty array');
  }

  const normalized = transactions.map((row) => ({
    date: row.date || '',
    description: row.description || '',
    amount: parseAmount(row.amount),
    balance: Number.isFinite(parseAmount(row.balance)) ? parseAmount(row.balance) : null,
  })).filter((row) => Number.isFinite(row.amount));

  if (normalized.length === 0) throw new Error('No valid transaction amounts found');

  const dates = normalized.map((row) => parseDate(row.date)).filter(Boolean);
  const start = dates.length ? dates.reduce((min, date) => date < min ? date : min) : null;
  const end = dates.length ? dates.reduce((max, date) => date > max ? date : max) : null;
  const periodMonths = monthsBetween(start, end);

  const outflows = normalized.filter((row) => row.amount < 0);
  const inflows = normalized.filter((row) => row.amount > 0);
  const totalInflow = inflows.reduce((sum, row) => sum + row.amount, 0);
  const totalOutflow = Math.abs(outflows.reduce((sum, row) => sum + row.amount, 0));
  const burnRate = totalOutflow / periodMonths;
  const latestBalance = normalized[normalized.length - 1].balance ?? normalized.reduce((sum, row) => sum + row.amount, 0);

  const onChainTotal = onChainPayments.reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
  const adjustedBalance = latestBalance + onChainTotal;
  const runwayMonths = burnRate > 0 ? adjustedBalance / burnRate : null;

  const flags = [];
  if (runwayMonths !== null && runwayMonths < RUNWAY_WARNING_MONTHS) {
    flags.push(`Runway is ${runwayMonths.toFixed(1)} months, below the 3-month warning threshold.`);
  }

  const largestRoundWithdrawal = outflows
    .filter((row) => isRoundWithdrawal(row.amount))
    .sort((a, b) => Math.abs(a.amount) - Math.abs(b.amount))
    .pop();

  if (largestRoundWithdrawal && Math.abs(largestRoundWithdrawal.amount) > latestBalance * ROUND_WITHDRAWAL_THRESHOLD) {
    flags.push(`${largestRoundWithdrawal.description || 'Round-number withdrawal'} of ${Math.abs(largestRoundWithdrawal.amount).toLocaleString('en-KE')} is ${(Math.abs(largestRoundWithdrawal.amount) / latestBalance * 100).toFixed(1)}% of the latest balance.`);
  }

  if (totalInflow === 0) {
    flags.push('No cash inflows appear in the CSV period, so revenue visibility is weak.');
  }

  if (outflows.length === 0) {
    flags.push('No cash outflows appear in the CSV period, so burn rate may be understated.');
  }

  const riskLevel = runwayMonths !== null && runwayMonths < RUNWAY_WARNING_MONTHS ? 'high' : flags.length > 0 ? 'medium' : 'low';

  return {
    balance: latestBalance,
    adjustedBalance,
    totalInflow,
    totalOutflow,
    burnRate,
    runwayMonths,
    periodMonths,
    transactionCount: normalized.length,
    onChainPayments: onChainPayments.length,
    onChainTotal,
    riskLevel,
    flags,
    transactions: normalized,
  };
}
