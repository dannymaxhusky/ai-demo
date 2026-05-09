// netlify/functions/credit-check.js
// Serverless function: calls OpenAI, Gemini, Claude in parallel for credit assessment
// Optional: ABN Lookup for Australian companies

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  let company;
  try {
    ({ company } = JSON.parse(event.body || '{}'));
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  if (!company || company.trim().length < 2) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Company name is required' }) };
  }

  const companyName = company.trim();

  // Build the credit assessment prompt
  const prompt = `You are a business credit risk analyst. Assess the credit risk profile of the company: "${companyName}".

Provide a structured assessment in the following JSON format (respond ONLY with valid JSON, no markdown):
{
  "company": "<confirmed company name or best match>",
  "country": "<likely country of incorporation>",
  "industry": "<industry sector>",
  "creditRating": "<AAA|AA|A|BBB|BB|B|CCC|CC|C|D|Unknown>",
  "riskLevel": "<Low|Moderate|High|Very High|Unknown>",
  "summary": "<2-3 sentence executive summary of credit risk>",
  "positives": ["<strength 1>", "<strength 2>"],
  "risks": ["<risk factor 1>", "<risk factor 2>"],
  "recommendation": "<Invest|Caution|Avoid|Insufficient Data>",
  "confidence": "<High|Medium|Low>",
  "disclaimer": "This is an AI-generated assessment for informational purposes only and does not constitute financial advice."
}`;

  // Determine if possibly Australian
  const ausKeywords = /\b(australia|australian|pty|ltd|asx|nsw|vic|qld|sa|wa|tas|act|nt)\b/i;
  const mightBeAustralian = ausKeywords.test(companyName);

  const results = {};

  // Run all API calls in parallel
  const tasks = await Promise.allSettled([
    callOpenAI(prompt, process.env.OPENAI_API_KEY),
    callGemini(prompt, process.env.GEMINI_API_KEY),
    callClaude(prompt, process.env.ANTHROPIC_API_KEY),
    mightBeAustralian || process.env.ABN_GUID
      ? callABN(companyName, process.env.ABN_GUID)
      : Promise.resolve(null),
  ]);

  const [openaiResult, geminiResult, claudeResult, abnResult] = tasks;

  results.openai = openaiResult.status === 'fulfilled'
    ? openaiResult.value
    : { error: openaiResult.reason?.message || 'OpenAI call failed' };

  results.gemini = geminiResult.status === 'fulfilled'
    ? geminiResult.value
    : { error: geminiResult.reason?.message || 'Gemini call failed' };

  results.claude = claudeResult.status === 'fulfilled'
    ? claudeResult.value
    : { error: claudeResult.reason?.message || 'Claude call failed' };

  if (abnResult.status === 'fulfilled' && abnResult.value) {
    results.abn = abnResult.value;
  }

  return { statusCode: 200, headers, body: JSON.stringify(results) };
};

// ── OpenAI ──────────────────────────────────────────────────────────────────
async function callOpenAI(prompt, apiKey) {
  if (!apiKey) throw new Error('OPENAI_API_KEY not configured');
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 800,
    }),
  });
  if (!res.ok) throw new Error(`OpenAI HTTP ${res.status}`);
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || '';
  return parseJSON(text);
}

// ── Gemini ───────────────────────────────────────────────────────────────────
async function callGemini(prompt, apiKey) {
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 800 },
    }),
  });
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  return parseJSON(text);
}

// ── Claude ───────────────────────────────────────────────────────────────────
async function callClaude(prompt, apiKey) {
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-3-haiku-20240307',
      max_tokens: 800,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Claude HTTP ${res.status}`);
  const data = await res.json();
  const text = data.content?.[0]?.text || '';
  return parseJSON(text);
}

// ── ABN Lookup ───────────────────────────────────────────────────────────────
async function callABN(companyName, guid) {
  if (!guid) return null;
  // Search by name
  const searchUrl = `https://abr.business.gov.au/json/MatchingNames.aspx?name=${encodeURIComponent(companyName)}&guid=${guid}`;
  const res = await fetch(searchUrl);
  if (!res.ok) return { error: `ABN HTTP ${res.status}` };
  // ABN API returns JSONP-style: callback({...})
  let text = await res.text();
  // Strip callback wrapper if present
  text = text.replace(/^[^(]+\(/, '').replace(/\);?\s*$/, '');
  let data;
  try { data = JSON.parse(text); } catch { return { error: 'ABN parse error' }; }

  const names = data?.Names || [];
  if (names.length === 0) return { found: false, message: 'No ABN records found' };

  // Take top result and fetch full entity details
  const top = names[0];
  const abn = (top.Abn || '').replace(/\s/g, '');
  if (!abn) return { found: true, names: names.slice(0, 5) };

  const detailUrl = `https://abr.business.gov.au/json/AbnDetails.aspx?abn=${abn}&guid=${guid}`;
  const dRes = await fetch(detailUrl);
  if (!dRes.ok) return { found: true, topMatch: top };
  let dText = await dRes.text();
  dText = dText.replace(/^[^(]+\(/, '').replace(/\);?\s*$/, '');
  let detail;
  try { detail = JSON.parse(dText); } catch { return { found: true, topMatch: top }; }

  return {
    found: true,
    abn: detail.Abn,
    entityName: detail.EntityName,
    entityType: detail.EntityTypeName,
    status: detail.AbnStatus,
    stateCode: detail.AddressState,
    postcode: detail.AddressPostcode,
    gstRegistered: detail.Gst ? `Registered from ${detail.Gst}` : 'Not registered',
    abnAge: detail.AbnStatusEffectiveFrom,
    otherNames: names.slice(0, 5).map(n => n.Name),
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function parseJSON(text) {
  // Strip markdown code fences if present
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // Try to extract JSON object from text
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch { /* fall through */ }
    }
    return { raw: text, error: 'Could not parse structured response' };
  }
}
