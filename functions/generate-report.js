const service = 'mizani-generate-report';
const version = '0.1.0';
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;

function safeScoreForReport(score) {
  const { transactions, ...safe } = score || {};
  return safe;
}

function sanitizeErrorMessage(message) {
  if (!message) return 'DeepSeek report failed';
  if (typeof message !== 'string') return 'DeepSeek report failed';
  const trimmed = message.trim();
  if (!trimmed) return 'DeepSeek report failed';
  return trimmed.length > 200 ? trimmed.slice(0, 200) + '...' : trimmed;
}

export default async function(req, res) {
  try {
    if (!DEEPSEEK_API_KEY) {
      return res.json({ service, version, ok: false, error: 'AI service is not configured' }, 500);
    }

    const safeScore = safeScoreForReport(req.body?.score);

    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          {
            role: 'user',
            content: `You are a financial controller writing for a Kenyan startup or SME founder. Use only the scored cash-flow data below. Be specific, cite the numbers, flag the riskiest item first, and keep it concise.

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
        temperature: 0.2,
        max_tokens: 900,
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      const errorMessage = data?.error?.message || data?.message || 'DeepSeek report failed';
      return res.json({ service, version, ok: false, error: sanitizeErrorMessage(errorMessage) }, response.status);
    }

    const text = data.choices?.[0]?.message?.content || '';
    return res.json({ service, version, report: text, generatedAt: new Date().toISOString() });
  } catch (err) {
    const message = err?.message || 'DeepSeek report failed';
    return res.json({ service, version, ok: false, error: sanitizeErrorMessage(message) }, 500);
  }
}
