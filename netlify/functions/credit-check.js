// netlify/functions/credit-check.js
// Serverless function: calls OpenAI, Gemini, Claude in parallel for credit assessment
// Optional: ABN Lookup for Australian companies
//
// Supported environment variables:
//   OPENAI_API_KEY      — required for OpenAI
//   OPENAI_BASE_URL     — optional, override base URL (e.g. domestic proxy)
//   OPENAI_MODEL        — optional, override model name (default: gpt-4o-mini)
//   GEMINI_API_KEY      — required for Gemini
//   GEMINI_BASE_URL     — optional, override base URL
//   GEMINI_MODEL        — optional, override model name (default: gemini-1.5-flash)
//   ANTHROPIC_API_KEY   — required for Claude
//   ANTHROPIC_BASE_URL  — optional, override base URL
//   ANTHROPIC_MODEL     — optional, override model name (default: claude-3-haiku-20240307)
//   ABN_GUID            — optional, enables ABN Lookup for Australian companies

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

  // Build the leasing-focused credit assessment prompt
  const prompt = `You are a credit risk analyst specialising in IT equipment leasing (computers, servers, and related hardware). Your client is an equipment rental company evaluating whether to lease IT equipment to the following business: "${companyName}".

Assess this company's suitability as a leasing customer and respond ONLY with valid JSON (no markdown, no explanation outside the JSON):
{
  "company": "<confirmed or best-matched company name>",
  "country": "<likely country of incorporation>",
  "industry": "<industry sector>",
  "companySize": "<Micro (<10)|Small (10-49)|Medium (50-249)|Large (250+)|Unknown>",
  "yearsInOperation": "<estimated years, e.g. '5-10 years' or 'Unknown'>",
  "leasingRisk": "<Low|Moderate|High|Very High|Unknown>",
  "creditRating": "<AAA|AA|A|BBB|BB|B|CCC|CC|C|D|Unknown>",
  "summary": "<2-3 sentence summary focused on this company's ability and likelihood to honour a rental agreement for IT equipment>",
  "leasingDecision": "<Approve|Approve with Conditions|Decline|Insufficient Data>",
  "recommendedCreditLimit": "<suggested maximum total lease value in AUD, e.g. 'AUD $20,000–$50,000' or 'N/A'>",
  "suggestedDeposit": "<recommended upfront deposit as a percentage, e.g. '10%' or '30%' or 'Nil'>",
  "suggestedPaymentTerms": "<e.g. 'Monthly, 12–24 month term' or 'Quarterly, short-term only'>",
  "strengths": ["<factor that supports approving the lease>"],
  "riskFactors": ["<factor that increases leasing risk>"],
  "conditions": ["<condition to attach if approving, e.g. 'Personal guarantee required' — empty array if none>"],
  "itEquipmentNeed": "<Low|Moderate|High — likelihood this type of business genuinely needs IT equipment>",
  "confidence": "<High|Medium|Low>",
  "disclaimer": "AI-generated assessment for internal reference only. Not a substitute for formal credit checks or legal advice."
}`;

  // Determine if possibly Australian
  const ausKeywords = /\b(australia|australian|pty|ltd|asx|nsw|vic|qld|sa|wa|tas|act|nt)\b/i;
  const mightBeAustralian = ausKeywords.test(companyName);

  // Capture actual model names used (for frontend display)
  const modelNames = {
    openai: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    gemini: process.env.GEMINI_MODEL || 'gemini-1.5-flash',
    claude: process.env.ANTHROPIC_MODEL || 'claude-3-haiku-20240307',
  };

  const results = { _models: modelNames };

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

  // Support domestic proxy: OPENAI_BASE_URL overrides the endpoint
  // Strip trailing slash AND trailing /v1 so users can safely include or omit it
  const baseUrl = (process.env.OPENAI_BASE_URL || 'https://api.openai.com')
    .replace(/\/+$/, '').replace(/\/v1$/, '');
  const model   = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const url     = `${baseUrl}/v1/chat/completions`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 800,
    }),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`OpenAI HTTP ${res.status}${errBody ? ': ' + errBody.slice(0, 120) : ''}`);
  }
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || '';
  return parseJSON(text);
}

// ── Gemini ───────────────────────────────────────────────────────────────────
// If GEMINI_BASE_URL is set, assume it's an OpenAI-compatible proxy
// (e.g. shubiaobiao.com) and use /v1/chat/completions format.
// Otherwise call Google's native Generative Language API.
async function callGemini(prompt, apiKey) {
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured');

  const model      = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
  const customBase = process.env.GEMINI_BASE_URL;

  let res;
  if (customBase) {
    // OpenAI-compatible proxy path
    const baseUrl = customBase.replace(/\/+$/, '').replace(/\/v1$/, '');
    const url     = `${baseUrl}/v1/chat/completions`;
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 800,
      }),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`Gemini(proxy) HTTP ${res.status}${errBody ? ': ' + errBody.slice(0, 120) : ''}`);
    }
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content || '';
    return parseJSON(text);
  } else {
    // Google native path
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 800 },
      }),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`Gemini HTTP ${res.status}${errBody ? ': ' + errBody.slice(0, 120) : ''}`);
    }
    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    return parseJSON(text);
  }
}

// ── Claude ───────────────────────────────────────────────────────────────────
// If ANTHROPIC_BASE_URL is set, assume OpenAI-compatible proxy and use
// /v1/chat/completions. Otherwise use Anthropic's native /v1/messages API.
async function callClaude(prompt, apiKey) {
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');

  const model      = process.env.ANTHROPIC_MODEL || 'claude-3-haiku-20240307';
  const customBase = process.env.ANTHROPIC_BASE_URL;

  let res;
  if (customBase) {
    // OpenAI-compatible proxy path
    const baseUrl = customBase.replace(/\/+$/, '').replace(/\/v1$/, '');
    const url     = `${baseUrl}/v1/chat/completions`;
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 800,
      }),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`Claude(proxy) HTTP ${res.status}${errBody ? ': ' + errBody.slice(0, 120) : ''}`);
    }
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content || '';
    return parseJSON(text);
  } else {
    // Anthropic native path
    const url = 'https://api.anthropic.com/v1/messages';
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: 800,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`Claude HTTP ${res.status}${errBody ? ': ' + errBody.slice(0, 120) : ''}`);
    }
    const data = await res.json();
    const text = data.content?.[0]?.text || '';
    return parseJSON(text);
  }
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
  if (!text) return { error: 'Empty response from model' };

  // 1. Strip markdown code fences (```json ... ``` or ``` ... ```)
  let cleaned = text
    .replace(/^```(?:json)?\s*/im, '')
    .replace(/\s*```\s*$/im, '')
    .trim();

  // 2. Try direct parse
  try { return JSON.parse(cleaned); } catch { /* continue */ }

  // 3. Find the outermost { ... } block (handles prose before/after JSON)
  const start = cleaned.indexOf('{');
  const end   = cleaned.lastIndexOf('}');
  if (start !== -1 && end > start) {
    const candidate = cleaned.slice(start, end + 1);
    try { return JSON.parse(candidate); } catch { /* continue */ }
  }

  // 4. Try greedy regex extraction as last resort
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (match) {
    try { return JSON.parse(match[0]); } catch { /* fall through */ }
  }

  // 5. Give up — return raw text so the UI can show something
  return { error: 'Could not parse structured response', raw: text.slice(0, 300) };
}
