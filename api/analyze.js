/**
 * /api/analyze
 *
 * The brain of bestdishintown.
 * Takes restaurant info + reviews, runs Claude Sonnet analysis,
 * returns a structured Dish Score with verdict, tags, and breakdown.
 *
 * POST body:
 *   {
 *     place_id:    string,
 *     name:        string,   // restaurant name
 *     dish:        string,   // dish being scored
 *     rating:      number,   // Google rating
 *     review_count: number,
 *     reviews:     Array<{ author, rating, text, date }>
 *   }
 *
 * Returns:
 *   {
 *     dish_score:     number (0–100),
 *     confidence:     "low" | "medium" | "high",
 *     verdict:        string (≤15 words, punchy),
 *     praise:         string[] (top 3, ≤5 words each),
 *     complaints:     string[] (top 2, ≤5 words each),
 *     dish_variety:   string | null,
 *     breakdown: {
 *       flavor:        number (0–100),
 *       authenticity:  number (0–100),
 *       consistency:   number (0–100),
 *       value:         number (0–100)
 *     },
 *     review_snippets: string[] (2 best quotes, ≤25 words each)
 *   }
 */

import Anthropic from '@anthropic-ai/sdk';
import { Redis } from '@upstash/redis';

const client    = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const redis     = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL   || process.env.BDIT_KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.BDIT_KV_REST_API_TOKEN
});

const CACHE_TTL_SECS   = 60 * 60 * 24; // 24 hours
const MAX_REVIEW_CHARS = 12000;          // stay within context limits
const MIN_MENTIONS     = 5;             // minimum dish mentions for "high" confidence

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  const { place_id, name, dish, rating, review_count, reviews } = body;

  if (!place_id || !name || !dish || !reviews?.length) {
    return res.status(400).json({ error: 'Missing required fields: place_id, name, dish, reviews' });
  }

  const cacheKey = `analysis:${place_id}:${dish.toLowerCase().replace(/\s+/g, '_')}`;

  try {
    // 1. Return cached analysis if available
    const cached = await redis.get(cacheKey);
    if (cached) {
      console.log(`[analyze] Cache hit: ${cacheKey}`);
      return res.status(200).json({ ...cached, from_cache: true });
    }

    // 2. Build the review text block (trimmed to token budget)
    const reviewBlock = buildReviewBlock(reviews, dish);
    const dishMentions = countMentions(reviews, dish);

    // 3. Call Claude Sonnet
    const analysis = await callClaude({ name, dish, rating, review_count, reviewBlock, dishMentions });

    // 4. Attach metadata and cache
    const result = {
      place_id,
      restaurant_name: name,
      dish,
      ...analysis,
      dish_mention_count: dishMentions,
      analyzed_review_count: reviews.length,
      analyzed_at: new Date().toISOString()
    };

    await redis.set(cacheKey, result, { ex: CACHE_TTL_SECS });

    return res.status(200).json({ ...result, from_cache: false });

  } catch (err) {
    console.error('[analyze] Error:', err.message);
    return res.status(500).json({ error: 'Analysis failed', detail: err.message });
  }
}

/**
 * Call Claude Sonnet with a structured prompt.
 * Returns parsed JSON with full dish analysis.
 */
async function callClaude({ name, dish, rating, review_count, reviewBlock, dishMentions }) {
  const confidence = dishMentions >= MIN_MENTIONS ? 'high'
    : dishMentions >= 2 ? 'medium'
    : 'low';

  const prompt = `You are a ruthlessly honest food critic who specializes in analyzing restaurant reviews to score specific dishes.

Your task: Analyze how good the "${dish}" is at "${name}" based on the reviews below.

Restaurant context:
- Google rating: ${rating} ⭐ (${review_count} total reviews)
- Reviews mentioning "${dish}": ${dishMentions}

Reviews:
${reviewBlock}

Respond ONLY with a valid JSON object. No preamble, no explanation, no markdown. Just JSON.

{
  "dish_score": <integer 0–100, based solely on dish quality not restaurant overall>,
  "confidence": "${confidence}",
  "verdict": "<one punchy sentence ≤15 words — what you'd tell a friend about this dish>",
  "praise": ["<praise point 1, ≤5 words>", "<praise point 2, ≤5 words>", "<praise point 3, ≤5 words>"],
  "complaints": ["<complaint 1, ≤5 words>", "<complaint 2, ≤5 words>"],
  "dish_variety": "<specific variety if mentioned e.g. 'Hyderabadi dum', 'fettuccine alfredo', or null>",
  "breakdown": {
    "flavor": <integer 0–100>,
    "authenticity": <integer 0–100>,
    "consistency": <integer 0–100>,
    "value": <integer 0–100>
  },
  "review_snippets": [
    "<most compelling review quote about the dish, ≤25 words>",
    "<second best quote, ≤25 words>"
  ]
}

Scoring guide:
- 90–100: Exceptional. People specifically drive here for this dish.
- 75–89:  Very good. Regulars order it every time.
- 60–74:  Solid. Worth ordering if you're already there.
- 40–59:  Mixed. Hit or miss depending on the day/server.
- Below 40: Avoid. Multiple reviewers were disappointed.

If fewer than 3 reviews mention the dish, set confidence to "low" and note this affects the score reliability.`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 800,
    messages: [{ role: 'user', content: prompt }]
  });

  const raw = response.content[0].text.trim();

  try {
    return JSON.parse(raw);
  } catch {
    // Claude occasionally wraps in backticks despite instructions
    const cleaned = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    return JSON.parse(cleaned);
  }
}

/**
 * Build a trimmed review block for the prompt.
 * Prioritizes reviews that mention the dish, truncates to MAX_REVIEW_CHARS.
 */
function buildReviewBlock(reviews, dish) {
  const keywords = dish.toLowerCase().split(' ').filter(w => w.length > 3);

  const sorted = [...reviews].sort((a, b) => {
    const aHit = keywords.some(k => a.text.toLowerCase().includes(k));
    const bHit = keywords.some(k => b.text.toLowerCase().includes(k));
    if (aHit && !bHit) return -1;
    if (!aHit && bHit) return 1;
    return (b.likes || 0) - (a.likes || 0);
  });

  let block = '';
  for (const r of sorted) {
    const line = `[${r.rating}★] "${r.text}"\n`;
    if ((block + line).length > MAX_REVIEW_CHARS) break;
    block += line;
  }

  return block || 'No reviews available.';
}

/**
 * Count how many reviews mention the dish by keyword.
 */
function countMentions(reviews, dish) {
  const keywords = dish.toLowerCase().split(' ').filter(w => w.length > 3);
  return reviews.filter(r =>
    keywords.some(k => r.text.toLowerCase().includes(k))
  ).length;
}
