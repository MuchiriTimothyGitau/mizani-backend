const DEFAULT_MONTHS = 3;
const RUNWAY_WARNING_MONTHS = 3;
const ROUND_WITHDRAWAL_THRESHOLD = 0.2;
const CUSTOMER_CONCENTRATION_THRESHOLD = 0.5;
const EXPENSE_CONCENTRATION_THRESHOLD = 0.35;
const BURN_ACCELERATION_THRESHOLD = 0.25;
const DAYS_SINCE_INFLOW_WARNING = 30;

function parseAmount(value) {
  if (value === undefined || value === null || value === '') return NaN;
  return Number(String(value).replace(/,/g, '').trim());
}

function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function monthsBetween(startDate, endDate) {
  if (!startDate || !endDate) return DEFAULT_MONTHS;
  const diffMs = endDate.getTime() - startDate.getTime();
  const diffMonths = diffMs / (1000 * 60 * 60 * 24 * 30.4375);
  return Math.max(1, diffMonths);
}

function daysBetween(startDate, endDate) {
  if (!startDate || !endDate) return null;
  return Math.max(0, Math.round((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)));
}

function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : 0;
}

function isRoundWithdrawal(amount) {
  return amount < 0 && Math.abs(amount) >= 1000 && Math.abs(amount) % 1000 === 0;
}

function isOpeningBalance(row) {
  return row.amount > 0 && /opening|balance|brought forward/i.test(row.description || '');
}

function averageOutflowPerTransaction(rows) {
  const outflows = rows.filter((row) => row.amount < 0);
  return outflows.length ? Math.abs(outflows.reduce((sum, row) => sum + row.amount, 0)) / outflows.length : 0;
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
  const inflows = normalized.filter((row) => row.amount > 0 && !isOpeningBalance(row));
  const totalInflow = inflows.reduce((sum, row) => sum + row.amount, 0);
  const totalOutflow = Math.abs(outflows.reduce((sum, row) => sum + row.amount, 0));
  const burnRate = totalOutflow / periodMonths;
  const latestBalance = normalized[normalized.length - 1].balance ?? normalized.reduce((sum, row) => sum + row.amount, 0);
  const onChainTotal = onChainPayments.reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
  const adjustedBalance = latestBalance + onChainTotal;
  const runwayMonths = burnRate > 0 ? adjustedBalance / burnRate : null;

  const orderedRows = normalized.slice().sort((a, b) => {
    const aDate = parseDate(a.date)?.getTime() || 0;
    const bDate = parseDate(b.date)?.getTime() || 0;
    return aDate - bDate;
  });
  const midpoint = Math.floor(orderedRows.length / 2);
  const firstHalfOutflowAverage = averageOutflowPerTransaction(orderedRows.slice(0, midpoint));
  const secondHalfOutflowAverage = averageOutflowPerTransaction(orderedRows.slice(midpoint));
  const burnAcceleration = firstHalfOutflowAverage > 0 ? (secondHalfOutflowAverage - firstHalfOutflowAverage) / firstHalfOutflowAverage : 0;

  const sortedInflows = inflows.slice().sort((a, b) => b.amount - a.amount);
  const topInflow = sortedInflows[0] || null;
  const topInflowShare = ratio(topInflow?.amount || 0, totalInflow);

  const sortedOutflows = outflows.slice().sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
  const largestExpense = sortedOutflows[0] || null;
  const largestExpenseShare = ratio(largestExpense ? Math.abs(largestExpense.amount) : 0, totalOutflow);

  const lastInflowDate = inflows.map((row) => parseDate(row.date)).filter(Boolean).sort((a, b) => b - a)[0] || null;
  const daysSinceLastInflow = daysBetween(lastInflowDate, end);

  const balanceRows = normalized.filter((row) => row.balance !== null).length;

  const flags = [];
  if (runwayMonths !== null && runwayMonths < RUNWAY_WARNING_MONTHS) {
    flags.push(`Runway is ${runwayMonths.toFixed(1)} months, below the 3-month warning threshold.`);
  }
  if (totalOutflow > totalInflow * 1.2) {
    flags.push(`Cash outflow is ${(totalOutflow / Math.max(totalInflow, 1)).toFixed(1)}x cash collected, so the business is burning faster than it is collecting.`);
  }
  if (topInflow && topInflowShare >= CUSTOMER_CONCENTRATION_THRESHOLD) {
    flags.push(`${topInflow.description || 'Largest inflow'} represents ${(topInflowShare * 100).toFixed(1)}% of cash collected, creating customer concentration risk.`);
  }
  if (largestExpense && largestExpenseShare >= EXPENSE_CONCENTRATION_THRESHOLD) {
    flags.push(`${largestExpense.description || 'Largest expense'} is ${(largestExpenseShare * 100).toFixed(1)}% of cash outflow, so one cost line can distort the runway.`);
  }
  if (burnAcceleration >= BURN_ACCELERATION_THRESHOLD) {
    flags.push(`Average outflow rose ${(burnAcceleration * 100).toFixed(1)}% in the second half of the period, showing burn acceleration.`);
  }
  if (daysSinceLastInflow !== null && daysSinceLastInflow > DAYS_SINCE_INFLOW_WARNING) {
    flags.push(`No cash inflow appears in the last ${daysSinceLastInflow} days of the CSV period.`);
  }
  if (balanceRows === 0) {
    flags.push('CSV has no balance column, so balance and runway are derived from signed transactions and may be incomplete.');
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
  const riskLevel = runwayMonths !== null && runwayMonths < RUNWAY_WARNING_MONTHS || topInflowShare >= 0.6 || burnAcceleration >= 0.5 ? 'high' : flags.length > 0 ? 'medium' : 'low';

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
    metrics: {
      inflowOutflowRatio: ratio(totalOutflow, totalInflow),
      topInflowShare,
      topInflowDescription: topInflow?.description || '',
      largestExpenseShare,
      largestExpenseDescription: largestExpense?.description || '',
      burnAcceleration,
      daysSinceLastInflow,
      hasBalanceColumn: balanceRows > 0,
    },
    transactions: normalized,
  };
}

const service = 'mizani-score-csv';
const version = '0.1.0';

function sanitizeErrorMessage(message) {
  if (!message) return 'Scoring failed';
  if (typeof message !== 'string') return 'Scoring failed';
  const trimmed = message.trim();
  if (!trimmed) return 'Scoring failed';
  return trimmed.length > 200 ? trimmed.slice(0, 200) + '...' : trimmed;
}

export default async function(req, res) {
  try {
    const { transactions, onChainPayments } = req.body || {};
    const result = scoreTransactions(transactions || [], onChainPayments || []);
    return res.json({ service, version, ...result });
  } catch (err) {
    return res.json({ service, version, ok: false, error: sanitizeErrorMessage(err.message) }, 400);
  }
}