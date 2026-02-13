// Server-side geo lookup with in-memory cache.
// Mixes ip-api batch + json lookups in parallel and enriches missing org fields.
// POST /api/geo  body: { ips: ["1.2.3.4", "5.6.7.8"] }
// Returns: { results: { "1.2.3.4": { country_code, country, org }, ... } }

const geoCache = new Map();

const EMPTY_INFO = { country_code: "", country: "", org: "" };
const IP_API_BATCH_URL = "http://ip-api.com/batch";
const IP_API_JSON_BASE = "http://ip-api.com/json";
const IP_API_FIELDS = "status,country,countryCode,org,isp,as,asname,query";
const JSON_LOOKUP_CONCURRENCY = 8;
const JSON_LOOKUP_MOD = 4; // ~25% of IPs go to json endpoint first

function hasGeoInfo(info) {
  return !!(info?.country_code || info?.country || info?.org);
}

function normalizeInfo(record) {
  if (!record || record.status !== "success") return { ...EMPTY_INFO };
  return {
    country_code: (record.countryCode || "").toUpperCase(),
    country: record.country || "",
    org: record.org || record.asname || record.as || record.isp || "",
  };
}

function mergeInfo(primary, secondary) {
  return {
    country_code: secondary.country_code || primary.country_code || "",
    country: secondary.country || primary.country || "",
    org: secondary.org || primary.org || "",
  };
}

function shouldUseJsonFirst(ip) {
  const last = Number(ip.split(".").at(-1));
  if (!Number.isFinite(last)) return false;
  return last % JSON_LOOKUP_MOD === 0;
}

async function lookupBatch(ips) {
  const out = {};
  if (ips.length === 0) return out;

  try {
    const res = await fetch(IP_API_BATCH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        ips.map((ip) => ({
          query: ip,
          fields: IP_API_FIELDS,
        }))
      ),
    });
    if (!res.ok) throw new Error(`ip-api batch returned ${res.status}`);

    const rows = await res.json();
    for (const row of rows || []) {
      if (!row?.query) continue;
      out[row.query] = normalizeInfo(row);
    }
  } catch {
    // Return partial/empty map; caller handles fallback.
  }

  return out;
}

async function lookupJsonOne(ip) {
  try {
    const res = await fetch(
      `${IP_API_JSON_BASE}/${ip}?fields=${encodeURIComponent(IP_API_FIELDS)}`
    );
    if (!res.ok) return { ...EMPTY_INFO };
    const row = await res.json();
    return normalizeInfo(row);
  } catch {
    return { ...EMPTY_INFO };
  }
}

async function lookupJsonMany(ips) {
  const out = {};
  if (ips.length === 0) return out;

  let index = 0;
  const workers = Array.from(
    { length: Math.min(JSON_LOOKUP_CONCURRENCY, ips.length) },
    async () => {
      while (index < ips.length) {
        const ip = ips[index++];
        out[ip] = await lookupJsonOne(ip);
      }
    }
  );
  await Promise.all(workers);
  return out;
}

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }

  const ips = body.ips;
  if (!Array.isArray(ips) || ips.length === 0 || ips.length > 100) {
    return Response.json(
      { error: "ips must be an array of 1-100 IPs" },
      { status: 400 }
    );
  }

  const ipRegex = /^\d{1,3}(\.\d{1,3}){3}$/;
  const validIps = ips.filter((ip) => typeof ip === "string" && ipRegex.test(ip));

  const results = {};
  const uncached = [];

  for (const ip of validIps) {
    if (geoCache.has(ip)) {
      results[ip] = geoCache.get(ip);
    } else {
      uncached.push(ip);
    }
  }

  if (uncached.length > 0) {
    const batchIps = [];
    const jsonIps = [];
    for (const ip of uncached) {
      if (shouldUseJsonFirst(ip)) jsonIps.push(ip);
      else batchIps.push(ip);
    }
    const jsonFirstSet = new Set(jsonIps);

    // Distribute load across batch/json endpoints and run both in parallel.
    const [batchMap, jsonMap] = await Promise.all([
      lookupBatch(batchIps),
      lookupJsonMany(jsonIps),
    ]);

    for (const ip of uncached) {
      const fromBatch = batchMap[ip] || { ...EMPTY_INFO };
      const fromJson = jsonMap[ip] || { ...EMPTY_INFO };
      const info = mergeInfo(fromBatch, fromJson);
      results[ip] = info;
      if (hasGeoInfo(info)) {
        geoCache.set(ip, info);
      }
    }

    // Enrich missing country/org using json lookup for batch-first IPs.
    const needsEnrichment = uncached.filter(
      (ip) =>
        !jsonFirstSet.has(ip) &&
        (!results[ip] || !results[ip].country || !results[ip].org)
    );
    if (needsEnrichment.length > 0) {
      const enrichMap = await lookupJsonMany(needsEnrichment);
      for (const ip of needsEnrichment) {
        const enriched = enrichMap[ip] || { ...EMPTY_INFO };
        const merged = mergeInfo(results[ip] || { ...EMPTY_INFO }, enriched);
        results[ip] = merged;
        if (hasGeoInfo(merged)) {
          geoCache.set(ip, merged);
        }
      }
    }

    for (const ip of uncached) {
      if (!results[ip]) {
        results[ip] = { ...EMPTY_INFO };
      }
    }
  }

  return Response.json({ results });
}
