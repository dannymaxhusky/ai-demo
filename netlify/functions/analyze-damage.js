exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  try {
    const { imageUrl, angleName = 'unknown', deviceType = 'laptop' } = JSON.parse(event.body || '{}');
    if (!imageUrl) return json(400, { error: 'imageUrl is required' });

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return json(200, mockResult(imageUrl, angleName, deviceType, 'OPENAI_API_KEY is not configured. Returning demo AI result.'));
    }

    const baseUrl = normalizeBaseUrl(process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1');
    const model = process.env.OPENAI_MODEL || process.env.OPENAI_VISION_MODEL || 'gpt-4.1-mini';
    const prompt = buildPrompt(deviceType, angleName);

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'system',
            content: 'You are an enterprise lease-return device inspection AI. Return strict JSON only. Do not use markdown.'
          },
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: imageUrl } }
            ]
          }
        ],
        temperature: 0.1,
        max_tokens: 1200
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      return json(200, mockResult(imageUrl, angleName, deviceType, `AI proxy error. Returning demo fallback. Detail: ${safeShort(errText)}`));
    }

    const data = await response.json();
    const text = extractChatText(data);
    const parsed = parseJsonOrFallback(text, imageUrl, angleName, deviceType);
    return json(200, normalizeResult(parsed, angleName, deviceType));
  } catch (error) {
    return json(200, mockResult('', 'unknown', 'unknown', `Function error. Returning demo fallback. Detail: ${error.message || String(error)}`));
  }
};

function buildPrompt(deviceType, angleName) {
  return `Analyze this lease-return device inspection photo for visible physical condition only.
Device type: ${deviceType}
Capture angle: ${angleName}

Return strict JSON only with this exact schema:
{
  "device_type": "laptop|desktop|monitor|unknown",
  "angle": "string",
  "summary": "short business-friendly inspection summary",
  "damages": [
    {
      "label": "scratch|dent|crack|screen_mark|missing_key|liquid_mark|port_damage|hinge_damage|none|other",
      "severity": "none|minor|moderate|major",
      "confidence": 0.0,
      "box": { "x": 0.0, "y": 0.0, "w": 0.0, "h": 0.0 },
      "evidence": "short visible evidence"
    }
  ],
  "charge": {
    "currency": "USD",
    "estimated_total": 0,
    "items": [ { "reason": "string", "amount": 0 } ]
  },
  "recommendation": "accept|review|charge|repair"
}

Bounding boxes must be approximate normalized coordinates from 0 to 1 relative to the image. If no chargeable damage is visible, return one damage item with label none, severity none, confidence above 0.6, box all zeros, estimated_total 0, and recommendation accept. Do not flag normal keyboard reflection, dust, lighting glare, or compression artifacts as damage.`;
}

function normalizeBaseUrl(url) {
  return String(url || '').replace(/\/+$/, '');
}

function extractChatText(data) {
  return data?.choices?.[0]?.message?.content || data?.choices?.[0]?.text || '{}';
}

function parseJsonOrFallback(text, imageUrl, angleName, deviceType) {
  const cleaned = String(text || '{}')
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch {}
    }
    return mockResult(imageUrl, angleName, deviceType, 'AI response was not valid JSON. Returning demo fallback.');
  }
}

function normalizeResult(result, angleName, deviceType) {
  const out = result && typeof result === 'object' ? result : {};
  out.device_type = out.device_type || deviceType || 'unknown';
  out.angle = out.angle || angleName || 'unknown';
  out.summary = out.summary || 'AI analysis completed.';
  if (!Array.isArray(out.damages) || !out.damages.length) {
    out.damages = [{ label: 'none', severity: 'none', confidence: 0.7, box: { x: 0, y: 0, w: 0, h: 0 }, evidence: 'No visible chargeable damage.' }];
  }
  out.damages = out.damages.map(d => ({
    label: d.label || 'other',
    severity: d.severity || 'minor',
    confidence: clampNumber(d.confidence, 0, 1, 0.6),
    box: normalizeBox(d.box),
    evidence: d.evidence || ''
  }));
  out.charge = out.charge || { currency: 'USD', estimated_total: 0, items: [] };
  out.recommendation = out.recommendation || 'review';
  return out;
}

function normalizeBox(box) {
  return {
    x: clampNumber(box?.x, 0, 1, 0),
    y: clampNumber(box?.y, 0, 1, 0),
    w: clampNumber(box?.w, 0, 1, 0),
    h: clampNumber(box?.h, 0, 1, 0)
  };
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function safeShort(text) {
  return String(text || '').slice(0, 500);
}

function json(statusCode, payload) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  };
}

function mockResult(imageUrl, angleName, deviceType, note) {
  return {
    device_type: deviceType,
    angle: angleName,
    summary: note || 'Demo AI analysis completed.',
    damages: [
      { label: 'scratch', severity: 'minor', confidence: 0.72, box: { x: 0.18, y: 0.28, w: 0.38, h: 0.16 }, evidence: 'Demo detection: surface mark candidate.' }
    ],
    charge: { currency: 'USD', estimated_total: 25, items: [{ reason: 'Minor cosmetic scratch candidate', amount: 25 }] },
    recommendation: 'review'
  };
}
