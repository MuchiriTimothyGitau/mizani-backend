const service = 'mizani-generate-report';
const version = '0.1.0';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

function safeScoreForReport(score) {
  const { transactions, ...safe } = score || {};
  return safe;
}

export default async function(req, res) {
  try {
    if (!GEMINI_API_KEY) {
      throw new Error('GEMINI_API_KEY is not configured');
    }
    
    const safeScore = safeScoreForReport(req.body?.score);

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`, {
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
    return res.json({ service, version, report: text, generatedAt: new Date().toISOString() });
  } catch (err) {
    return res.json({ service, version, ok: false, error: err.message }, 500);
  }
}