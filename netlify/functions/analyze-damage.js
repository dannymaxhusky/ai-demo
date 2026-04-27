exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  try {
    const { imageUrl, angleName = 'unknown', deviceType = 'laptop' } = JSON.parse(event.body || '{}');
    if (!imageUrl) return json(400, { error: 'imageUrl is required' });

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return json(200, applyRuleEngine(mockResult(imageUrl, angleName, deviceType, 'OPENAI_API_KEY is not configured. Returning demo AI result.'), angleName));
    }

    const baseUrl = normalizeBaseUrl(process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1');
    const model = process.env.OPENAI_MODEL || process.env.OPENAI_VISION_MODEL || 'gpt-4.1-mini';
    const prompt = buildPrompt(deviceType, angleName);

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: 'You are an enterprise lease-return inspection AI. Return strict JSON only. Do not use markdown. Be conservative: false damage claims are worse than missed minor cosmetic marks.' },
          { role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: imageUrl } }] }
        ],
        temperature: 0.05,
        max_tokens: 1200
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      return json(200, applyRuleEngine(mockResult(imageUrl, angleName, deviceType, `AI proxy error. Returning demo fallback. Detail: ${safeShort(errText)}`), angleName));
    }

    const data = await response.json();
    const parsed = parseJsonOrFallback(extractChatText(data), imageUrl, angleName, deviceType);
    const normalized = normalizeResult(parsed, angleName, deviceType);
    return json(200, applyRuleEngine(normalized, angleName));
  } catch (error) {
    return json(200, applyRuleEngine(mockResult('', 'unknown', 'unknown', `Function error. Returning demo fallback. Detail: ${error.message || String(error)}`), 'unknown'));
  }
};

function buildPrompt(deviceType, angleName) {
  return `Analyze this lease-return device inspection photo for physical condition only. Device type: ${deviceType}. Capture angle: ${angleName}.

Return strict JSON only with this schema: {"device_type":"laptop|desktop|monitor|unknown","angle":"string","summary":"short business-friendly inspection summary","damages":[{"label":"scratch|dent|crack|screen_mark|missing_key|liquid_mark|port_damage|hinge_damage|none|other","severity":"none|minor|moderate|major","confidence":0.0,"box":{"x":0.0,"y":0.0,"w":0.0,"h":0.0},"evidence":"short visible evidence"}],"charge":{"currency":"USD","estimated_total":0,"items":[{"reason":"string","amount":0}]},"recommendation":"accept|review|charge|repair"}.

Important guardrails:
- Do NOT flag glare, dust, fingerprints, screen reflection, keyboard backlight, sticker residue, camera blur, compression artifacts, or normal wear as chargeable damage.
- Only classify chargeable damage when the visible evidence is localized, persistent, and structurally meaningful.
- Normal keyboard reflections and shiny plastic highlights are not scratches.
- Bounding boxes must be normalized 0..1. If no chargeable damage is visible, return one item: label none, severity none, confidence > 0.6, box all zeros, estimated_total 0, recommendation accept.`;
}

const MIN_CONFIDENCE = { scratch: 0.82, dent: 0.78, crack: 0.84, screen_mark: 0.82, missing_key: 0.86, liquid_mark: 0.88, port_damage: 0.84, hinge_damage: 0.84, other: 0.85 };
const CHARGEABLE = new Set(['scratch','dent','crack','screen_mark','missing_key','liquid_mark','port_damage','hinge_damage','other']);
const ARTIFACT_WORDS = ['glare','reflection','reflect','dust','fingerprint','smudge','shadow','lighting','blur','overexposure','screen content','keyboard light','artifact','compression','sticker','label','normal wear','wear pattern'];

function applyRuleEngine(result, angleName) {
  const filtered = [];
  const suppressed = [];
  for (const d of result.damages || []) {
    const decision = evaluateDamage(d, angleName);
    const enriched = { ...d, rule_decision: decision.status, rule_reason: decision.reason };
    if (decision.status === 'suppress') suppressed.push(enriched);
    else filtered.push(enriched);
  }

  if (!filtered.length) {
    result.damages = [{ label: 'none', severity: 'none', confidence: 0.8, box: { x: 0, y: 0, w: 0, h: 0 }, evidence: 'No chargeable damage after AI + rule-engine review.', rule_decision: 'accept', rule_reason: 'all AI findings were below threshold or likely artifacts' }];
    result.recommendation = 'accept';
    result.summary = 'No chargeable damage confirmed after rule-engine validation.';
  } else {
    result.damages = filtered;
    result.recommendation = filtered.some(d => d.severity === 'major') ? 'review' : 'charge';
    result.summary = `${filtered.length} potential chargeable finding(s) after rule-engine validation.`;
  }

  result.rule_engine = {
    version: 'guardrails-v1',
    status: filtered.length ? 'chargeable_findings_validated' : 'no_chargeable_damage',
    suppressed_count: suppressed.length,
    suppressed_findings: suppressed.map(d => ({ label: d.label, severity: d.severity, confidence: d.confidence, reason: d.rule_reason }))
  };
  return result;
}

function evaluateDamage(d, angleName) {
  const label = String(d.label || 'other');
  const severity = String(d.severity || 'minor');
  const confidence = Number(d.confidence || 0);
  const evidence = String(d.evidence || '').toLowerCase();
  const angle = String(angleName || '').toLowerCase();
  const box = normalizeBox(d.box);
  const area = box.w * box.h;

  if (label === 'none' || severity === 'none') return { status: 'suppress', reason: 'non-chargeable none finding' };
  if (!CHARGEABLE.has(label)) return { status: 'suppress', reason: 'unsupported damage label' };
  if (confidence < (MIN_CONFIDENCE[label] || 0.85)) return { status: 'suppress', reason: `confidence ${confidence.toFixed(2)} below ${label} threshold` };
  if (area <= 0.002) return { status: 'suppress', reason: 'bounding box too small to support charge' };
  if (area > 0.75 && ['scratch','screen_mark','dent'].includes(label)) return { status: 'suppress', reason: 'bounding box too large, likely lighting or image artifact' };
  if (ARTIFACT_WORDS.some(w => evidence.includes(w))) return { status: 'suppress', reason: 'evidence text suggests reflection/dust/artifact, not damage' };
  if (angle.includes('keyboard') && label === 'scratch' && severity === 'minor' && confidence < 0.9) return { status: 'suppress', reason: 'minor keyboard scratch requires higher confidence due reflection risk' };
  if (angle.includes('screen') && label === 'screen_mark' && confidence < 0.88) return { status: 'suppress', reason: 'screen mark requires high confidence due glare/reflection risk' };
  if (['liquid_mark','missing_key','crack','hinge_damage','port_damage'].includes(label) && severity === 'minor') return { status: 'review', reason: 'functional-risk category retained for manual review' };
  return { status: severity === 'major' ? 'review' : 'charge', reason: 'passes confidence, artifact, size, and angle checks' };
}

function normalizeBaseUrl(url) { return String(url || '').replace(/\/+$/, ''); }
function extractChatText(data) { return data?.choices?.[0]?.message?.content || data?.choices?.[0]?.text || '{}'; }
function parseJsonOrFallback(text, imageUrl, angleName, deviceType) { const cleaned = String(text || '{}').replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim(); try { return JSON.parse(cleaned); } catch { const match = cleaned.match(/\{[\s\S]*\}/); if (match) { try { return JSON.parse(match[0]); } catch {} } return mockResult(imageUrl, angleName, deviceType, 'AI response was not valid JSON. Returning demo fallback.'); } }
function normalizeResult(result, angleName, deviceType) { const out = result && typeof result === 'object' ? result : {}; out.device_type = out.device_type || deviceType || 'unknown'; out.angle = out.angle || angleName || 'unknown'; out.summary = out.summary || 'AI analysis completed.'; if (!Array.isArray(out.damages) || !out.damages.length) out.damages = [{ label: 'none', severity: 'none', confidence: 0.7, box: { x: 0, y: 0, w: 0, h: 0 }, evidence: 'No visible chargeable damage.' }]; out.damages = out.damages.map(d => ({ label: d.label || 'other', severity: d.severity || 'minor', confidence: clampNumber(d.confidence, 0, 1, 0.6), box: normalizeBox(d.box), evidence: d.evidence || '' })); out.charge = out.charge || { currency: 'USD', estimated_total: 0, items: [] }; out.recommendation = out.recommendation || 'review'; return out; }
function normalizeBox(box) { return { x: clampNumber(box?.x, 0, 1, 0), y: clampNumber(box?.y, 0, 1, 0), w: clampNumber(box?.w, 0, 1, 0), h: clampNumber(box?.h, 0, 1, 0) }; }
function clampNumber(value, min, max, fallback) { const n = Number(value); if (!Number.isFinite(n)) return fallback; return Math.min(max, Math.max(min, n)); }
function safeShort(text) { return String(text || '').slice(0, 500); }
function json(statusCode, payload) { return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }; }
function mockResult(imageUrl, angleName, deviceType, note) { return { device_type: deviceType, angle: angleName, summary: note || 'Demo AI analysis completed.', damages: [{ label: 'scratch', severity: 'minor', confidence: 0.72, box: { x: 0.18, y: 0.28, w: 0.38, h: 0.16 }, evidence: 'Demo detection: surface mark candidate.' }], charge: { currency: 'USD', estimated_total: 25, items: [{ reason: 'Minor cosmetic scratch candidate', amount: 25 }] }, recommendation: 'review' }; }
