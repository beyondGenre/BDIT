/**
 * /api/fetch-reviews
 *
 * Pulls Google reviews for a given place_id via Outscraper.
 * Filters reviews to only those that mention the target dish.
 * Caches results in Upstash Redis for 24 hours to control API costs.
 *
 * Query params:
 *   place_id  - Google place_id (from find-restaurants)
 *   dish      - dish name to filter reviews by relevance
 *   limit     - max reviews to fetch (default: 100)
 */

import { Redis } from '@upstash/redis';

const OUTSCRAPER_API_KEY = process.env.OUTSCRAPER_API_KEY;
const UPSTASH_URL        = process.env.UPSTASH_REDIS_REST_URL  || process.env.BDIT_KV_REST_API_URL;
const UPSTASH_TOKEN      = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.BDIT_KV_REST_API_TOKEN;

const DEFAULT_LIMIT  = 100;
const CACHE_TTL_SECS = 60 * 60 * 24; // 24 hours

const redis = new Redis({ url: UPSTASH_URL, token: UPSTASH_TOKEN });

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { place_id, dish, limit = DEFAULT_LIMIT } = req.query;

  if (!place_id || !dish) {
    return res.status(400).json({ error: 'Missing required params: place_id, dish' });
  }

  const cacheKey = `reviews:${place_id}:${dish.toLowerCase().replace(/\s+/g, '_')}`;

  try {
    // 1. Check Redis cache first
    const cached = await redis.get(cacheKey);
    if (cached) {
      console.log(`[fetch-reviews] Cache hit: ${cacheKey}`);
      return res.status(200).json({ ...cached, from_cache: true });
    }

    // 2. Fetch from Outscraper
    const reviews = await fetchFromOutscraper({ place_id, limit: parseInt(limit) });

    // 3. Filter to reviews that mention the dish
    const dishReviews = filterByDish(reviews, dish);

    const payload = {
      place_id,
      dish,
      total_fetched: reviews.length,
      dish_mentions: dishReviews.length,
      reviews: dishReviews,
      all_reviews: reviews, // include all for Claude to analyze context
      fetched_at: new Date().toISOString()
    };

    // 4. Cache for 24 hours
    await redis.set(cacheKey, payload, { ex: CACHE_TTL_SECS });

    return res.status(200).json({ ...payload, from_cache: false });

  } catch (err) {
    console.error('[fetch-reviews] Error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch reviews', detail: err.message });
  }
}

/**
 * Fetch reviews from Outscraper API.
 * Outscraper returns full Google review data including rating,
 * review text, reviewer name, date, and likes.
 */
async function fetchFromOutscraper({ place_id, limit }) {
  if (!OUTSCRAPER_API_KEY) throw new Error('Outscraper API key not configured');

  const params = new URLSearchParams({
    query: place_id,
    reviewsLimit: String(limit),
    language: 'en',
    sort: 'mostRelevant',
    async: 'false'
  });

  const url = `https://api.app.outscraper.com/maps/reviews-v3?${params.toString()}`;

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'X-API-KEY': OUTSCRAPER_API_KEY
    }
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Outscraper error: ${res.status} — ${errText}`);
  }

  const data = await res.json();
  console.log('OUTSCRAPER RAW:', JSON.stringify(data).slice(0, 3000));
  console.log('DATA KEYS:', Object.keys(data?.data?.[0] || {}));
  console.log('HAS REVIEWS_DATA:', !!data?.data?.[0]?.reviews_data);
  console.log('DATA LENGTH:', data?.data?.length);

  // Handle async task response — poll until done
  if (data?.id && !data?.data) {
    const taskData = await pollOutscraperTask(data.id);
    return parseReviews(taskData);
  }

  // Outscraper returns reviews as a flat array in data.data
  // Each element is a review object (not nested in reviews_data)
  const rawData = data?.data || [];

  // If first item has reviews_data, it's the nested format
  if (rawData[0]?.reviews_data) {
    return parseReviews(rawData[0].reviews_data);
  }

  // Otherwise each item in data.data is a review directly
  return parseReviews(rawData);
}

function parseReviews(reviewsData) {
  return reviewsData
    .filter(r => r.review_text && r.review_text.trim().length > 20)
    .map(r => ({
      author: r.author_title || 'Anonymous',
      rating: r.review_rating,
      text: r.review_text,
      date: r.review_datetime_utc,
      likes: r.review_likes || 0
    }));
}

async function pollOutscraperTask(taskId, maxAttempts = 8) {
  const pollUrl = `https://api.app.outscraper.com/requests/${taskId}`;

  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, 3000));

    const res = await fetch(pollUrl, {
      headers: { 'X-API-KEY': OUTSCRAPER_API_KEY }
    });

    if (!res.ok) continue;

    const data = await res.json();

    if (data?.data) {
      const raw = data.data;
      if (raw[0]?.reviews_data) return raw[0].reviews_data;
      return raw;
    }
    if (data?.status === 'Failed') throw new Error(`Outscraper task failed`);
  }

  return [];
}

/**
 * Filter reviews to those that mention the target dish.
 * Uses simple keyword matching — Claude does the deep analysis later.
 * Sorts dish-relevant reviews to the top.
 */
function filterByDish(reviews, dish) {
  const keywords = buildKeywords(dish);

  return reviews
    .map(review => ({
      ...review,
      mentions_dish: keywords.some(kw =>
        review.text.toLowerCase().includes(kw)
      )
    }))
    .sort((a, b) => {
      if (a.mentions_dish && !b.mentions_dish) return -1;
      if (!a.mentions_dish && b.mentions_dish) return 1;
      return (b.likes || 0) - (a.likes || 0); // sort by helpfulness
    });
}

/**
 * Build keyword variants for dish matching.
 * e.g. "alfredo pasta" → ["alfredo pasta", "alfredo", "fettuccine alfredo"]
 */
function buildKeywords(dish) {
  const base = dish.toLowerCase();
  const words = base.split(' ').filter(w => w.length > 3);
  return [...new Set([base, ...words])];
}
