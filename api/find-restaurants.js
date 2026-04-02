
/**
 * /api/find-restaurants
 * 
 * Takes a dish + user coordinates, returns nearby restaurants
 * that likely serve that dish, ranked by relevance + rating.
 *
 * Query params:
 *   dish     - e.g. "alfredo pasta"
 *   lat      - user latitude
 *   lng      - user longitude
 *   radius   - search radius in meters (default: 8000 = ~5 miles)
 *   limit    - max results to return (default: 10)
 */

const GOOGLE_PLACES_API_KEY = process.env.GOOGLE_PLACES_API_KEY;
const DEFAULT_RADIUS = 8000;
const DEFAULT_LIMIT = 10;
const MIN_RATING = 3.5;
const MIN_REVIEWS = 20;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { dish, lat, lng, radius = DEFAULT_RADIUS, limit = DEFAULT_LIMIT } = req.query;

  if (!dish || !lat || !lng) {
    return res.status(400).json({
      error: 'Missing required params: dish, lat, lng'
    });
  }

  if (!GOOGLE_PLACES_API_KEY) {
    return res.status(500).json({ error: 'Google Places API key not configured' });
  }

  try {
    const restaurants = await findRestaurants({
      dish,
      lat: parseFloat(lat),
      lng: parseFloat(lng),
      radius: parseInt(radius),
      limit: parseInt(limit)
    });

    return res.status(200).json({
      dish,
      location: { lat: parseFloat(lat), lng: parseFloat(lng) },
      radius_meters: parseInt(radius),
      count: restaurants.length,
      restaurants
    });

  } catch (err) {
    console.error('[find-restaurants] Error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch restaurants', detail: err.message });
  }
}

/**
 * Core search logic:
 * 1. Text search for "{dish} restaurant near lat,lng"
 * 2. Filter by rating + review count thresholds
 * 3. Enrich each result with place details (hours, website, photos)
 * 4. Return cleaned, ranked list
 */
async function findRestaurants({ dish, lat, lng, radius, limit }) {
  const searchQuery = encodeURIComponent(`${dish} restaurant`);
  const location = `${lat},${lng}`;

  const searchUrl = `https://maps.googleapis.com/maps/api/place/textsearch/json` +
    `?query=${searchQuery}` +
    `&location=${location}` +
    `&radius=${radius}` +
    `&type=restaurant` +
    `&key=${GOOGLE_PLACES_API_KEY}`;

  const searchRes = await fetch(searchUrl);
  if (!searchRes.ok) throw new Error(`Places API error: ${searchRes.status}`);

  const searchData = await searchRes.json();

  if (searchData.status !== 'OK' && searchData.status !== 'ZERO_RESULTS') {
    throw new Error(`Places API status: ${searchData.status}`);
  }

  const raw = searchData.results || [];

  const filtered = raw
    .filter(p => p.rating >= MIN_RATING && (p.user_ratings_total || 0) >= MIN_REVIEWS)
    .slice(0, limit * 2); // fetch more than needed so we have room to filter

  const enriched = await Promise.all(
    filtered.map(place => enrichPlace(place))
  );

  return enriched
    .filter(Boolean)
    .slice(0, limit)
    .map((place, idx) => ({
      rank: idx + 1,
      place_id: place.place_id,
      name: place.name,
      address: place.formatted_address || place.vicinity,
      rating: place.rating,
      review_count: place.user_ratings_total,
      price_level: place.price_level,
      location: {
        lat: place.geometry.location.lat,
        lng: place.geometry.location.lng
      },
      distance_meters: haversine(lat, lng, place.geometry.location.lat, place.geometry.location.lng),
      phone: place.formatted_phone_number || null,
      website: place.website || null,
      hours: place.opening_hours?.weekday_text || null,
      is_open_now: place.opening_hours?.open_now ?? null,
      google_maps_url: `https://maps.google.com/?place_id=${place.place_id}`,
      photo_ref: place.photos?.[0]?.photo_reference || null
    }));
}

/**
 * Fetch full place details for a single result.
 * The text search gives us basic data; details gives us phone, hours, website.
 */
async function enrichPlace(place) {
  try {
    const fields = [
      'place_id', 'name', 'formatted_address', 'vicinity',
      'rating', 'user_ratings_total', 'price_level',
      'geometry', 'photos', 'formatted_phone_number',
      'website', 'opening_hours'
    ].join(',');

    const detailUrl = `https://maps.googleapis.com/maps/api/place/details/json` +
      `?place_id=${place.place_id}` +
      `&fields=${fields}` +
      `&key=${GOOGLE_PLACES_API_KEY}`;

    const res = await fetch(detailUrl);
    const data = await res.json();

    if (data.status !== 'OK') return place;
    return { ...place, ...data.result };
  } catch {
    return place;
  }
}

/**
 * Haversine distance in meters between two lat/lng points.
 */
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

function toRad(deg) { return (deg * Math.PI) / 180; }
