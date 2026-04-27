exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const { imageUrl, angleName = 'unknown', deviceType = 'laptop' } = JSON.parse(event.body || '{}');
    if (!imageUrl) {
      return { statusCode: 400, body: JSON.stringify({ error: 'imageUrl is required' }) };
    }

    if (!process.env.OPENAI_API_KEY) {
      return {
        statusCode: 200,
        body: JSON.stringify(mockResult(imageUrl, angleName, deviceType, 'OPENAI_API_KEY is not configured. Returning demo AI result.'))
      };
    }

    const prompt = `You are an enterprise lease-return device inspection assistant. Analyze the image for physical device condition only. Device type: ${deviceType}. Capture angle: ${angleName}. Return strict JSON only with this shape: {"device_type":"laptop|desktop|monitor|unknown","angle":"string","summary":"string","damages":[{"label":"scratch|dent|crack|screen_mark|missing_key|liquid_mark|port_damage|hinge_damage|none|other","severity":"none|minor|moderate|major","confidence":0.0,"box":{"x":0.0,"y":0.0,"w":0.0,"h":0.0},"evidence":"short visible evidence"}],"charge":{"currency":"USD","estimated_total":number,"items":[{"reason":"string","amount":number}]},"recommendation":"accept|review|charge|repair"}. Bounding boxes must be approximate normalized coordinates from 0 to 1 relative to the image. If no damage is visible, return one damage item with label none, severity none, confidence > 0.6, and zero charge.`;

    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: process.env.OPENAI_VISION_MODEL || 'gpt-4.1-mini',
        input: [{
          role: 'user',
          content: [
            { type: 'input_text', text: prompt },
            { type: 'input_image', image_url: imageUrl, detail: 'high' }
          ]
        }],
        text: { format: { type: 'json_object' } }
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      return { statusCode: 502, body: JSON.stringify({ error: 'OpenAI API error', detail: errText }) };
    }

    const data = await response.json();
    const text = data.output_text || data.output?.flatMap(o => o.content || []).find(c => c.text)?.text || '{}';
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = mockResult(imageUrl, angleName, deviceType, 'AI response was not valid JSON.'); }
    return { statusCode: 200, body: JSON.stringify(parsed) };
  } catch (error) {
    return { statusCode: 500, body: JSON.stringify({ error: error.message || String(error) }) };
  }
};

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
