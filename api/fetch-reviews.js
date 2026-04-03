/**
 * /api/fetch-reviews
 *
 * Pulls Google reviews for a given place_id via Google Places API.
 * Google returns up to 5 reviews per call — enough for Claude to score a dish.
 * Caches results in Upstash Redis for 24 hours.
 *
 * Query params:
 *   place_id  - Google place_id (from find-restaurants)
 *   dish      - dish name to filter reviews by relevance
 */

import { Redis } from '@upstash/redis';

const GOOGLE_API_KEY  = process.env.GOOGLE_PLACES_API_KEY;
const UPSTASH_URL     = process.env.UPSTASH_REDIS_REST_URL   || process.env.BDIT_KV_REST_API_URL;
const UPSTASH_TOKEN   = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.BDIT_KV_REST_API_TOKEN;
const CACHE_TTL_SECS  = 60 * 60 * 24; // 24 hours

const redis = new Redis({ url: UPSTASH_URL, token: UPSTASH_TOKEN });

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { place_id, dish } = req.query;

  if (!place_id || !dish) {
    return res.status(400).json({ error: 'Missing required params: place_id, dish' });
  }

  const cacheKey = `reviews:${place_id}:${dish.toLowerCase().replace(/\s+/g, '_')}`;

  try {
    // Check cache first
    const cached = await redis.get(cacheKey);
    if (cached) {
      console.log(`[fetch-reviews] Cache hit: ${cacheKey}`);
      return res.status(200).json({ ...cached, from_cache: true });
    }

    // Fetch from Google Places API
    const reviews = await fetchGoogleReviews(place_id, dish);

    const payload = {
      place_id,
      dish,
      total_fetched: reviews.all.length,
      dish_mentions: reviews.mentions,
      reviews: reviews.filtered,
      all_reviews: reviews.all,
      fetched_at: new Date().toISOString()
    };

    // Cache result
    await redis.set(cacheKey, payload, { ex: CACHE_TTL_SECS });

    return res.status(200).json({ ...payload, from_cache: false });

  } catch (err) {
    console.error('[fetch-reviews] Error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch reviews', detail: err.message });
  }
}

async function fetchGoogleReviews(place_id, dish) {
  const fields = 'reviews,rating,user_ratings_total,name';
  const url = `https://maps.googleapis.com/maps/api/place/details/json` +
    `?place_id=${place_id}` +
    `&fields=${fields}` +
    `&reviews_sort=most_relevant` +
    `&key=${GOOGLE_API_KEY}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Google Places API error: ${res.status}`);

  const data = await res.json();

  if (data.status !== 'OK') {
    throw new Error(`Google Places status: ${data.status}`);
  }

  const rawReviews = data.result?.reviews || [];
  console.log(`[fetch-reviews] Google returned ${rawReviews.length} reviews`);

  const all = rawReviews.map(r => ({
    author: r.author_name || 'Anonymous',
    rating: r.rating,
    text: r.text,
    date: r.relative_time_description,
    likes: 0
  }));

  const keywords = buildKeywords(dish);
  const filtered = all.filter(r =>
    keywords.some(kw => r.text?.toLowerCase().includes(kw))
  );

  console.log(`[fetch-reviews] Dish mentions: ${filtered.length}/${all.length}`);

  return {
    all,
    filtered,
    mentions: filtered.length
  };
}

function buildKeywords(dish) {
  const base = dish.toLowerCase();
  const words = base.split(' ').filter(w => w.length > 3);
  return [...new Set([base, ...words])];
}
