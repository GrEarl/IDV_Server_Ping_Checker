// Server-side geo lookup with in-memory cache.
// Uses multiple providers in parallel to reduce single-provider rate-limit impact.
// POST /api/geo  body: { ips: ["1.2.3.4", "5.6.7.8"] }
// Returns: { results: { "1.2.3.4": { country_code, country, org }, ... } }

const geoCache = new Map();

const EMPTY_INFO = { country_code: "", country: "", org: "" };
const IP_API_BATCH_URL = "http://ip-api.com/batch";
const IP_API_JSON_BASE = "http://ip-api.com/json";
const IPWHOIS_BASE_URL = "https://ipwho.is";
const IP_API_FIELDS = "status,country,countryCode,org,isp,as,asname,query";
const JSON_LOOKUP_CONCURRENCY = 8;
const IPWHOIS_LOOKUP_CONCURRENCY = 8;

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

function normalizeIpWhoisInfo(record) {
  if (!record || record.success === false) return { ...EMPTY_INFO };
  const connection = record.connection || {};
  return {
    country_code: (record.country_code || "").toUpperCase(),
    country: record.country || "",
    org:
      connection.org ||
      connection.isp ||
      connection.asn ||
      connection.domain ||
      "",
  };
}

function mergeInfo(primary, secondary) {
  return {
    country_code: secondary.country_code || primary.country_code || "",
    country: secondary.country || primary.country || "",
    org: secondary.org || primary.org || "",
  };
}

function selectPrimaryProvider(ip) {
  const last = Number(ip.split(".").at(-1));
  if (!Number.isFinite(last)) return "batch";

  // Load split by deterministic bucket:
  // 50% batch, 16.7% ip-api/json, 33.3% ipwho.is
  const bucket = last % 6;
  if (bucket === 0 || bucket === 1) return "ipwhois";
  if (bucket === 2) return "json";
  return "batch";
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

async function lookupIpApiJsonOne(ip) {
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

async function lookupIpApiJsonMany(ips) {
  const out = {};
  if (ips.length === 0) return out;

  let index = 0;
  const workers = Array.from(
    { length: Math.min(JSON_LOOKUP_CONCURRENCY, ips.length) },
    async () => {
      while (index < ips.length) {
        const ip = ips[index++];
        out[ip] = await lookupIpApiJsonOne(ip);
      }
    }
  );
  await Promise.all(workers);
  return out;
}

async function lookupIpWhoisOne(ip) {
  try {
    const res = await fetch(`${IPWHOIS_BASE_URL}/${ip}`);
    if (!res.ok) return { ...EMPTY_INFO };
    const row = await res.json();
    return normalizeIpWhoisInfo(row);
  } catch {
    return { ...EMPTY_INFO };
  }
}

async function lookupIpWhoisMany(ips) {
  const out = {};
  if (ips.length === 0) return out;

  let index = 0;
  const workers = Array.from(
    { length: Math.min(IPWHOIS_LOOKUP_CONCURRENCY, ips.length) },
    async () => {
      while (index < ips.length) {
        const ip = ips[index++];
        out[ip] = await lookupIpWhoisOne(ip);
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
    const ipApiJsonIps = [];
    const ipWhoisIps = [];
    for (const ip of uncached) {
      const provider = selectPrimaryProvider(ip);
      if (provider === "json") ipApiJsonIps.push(ip);
      else if (provider === "ipwhois") ipWhoisIps.push(ip);
      else batchIps.push(ip);
    }
    const ipApiJsonSet = new Set(ipApiJsonIps);
    const ipWhoisSet = new Set(ipWhoisIps);

    // Distribute load across providers and run lookups in parallel.
    const [batchMap, ipApiJsonMap, ipWhoisMap] = await Promise.all([
      lookupBatch(batchIps),
      lookupIpApiJsonMany(ipApiJsonIps),
      lookupIpWhoisMany(ipWhoisIps),
    ]);

    for (const ip of uncached) {
      const fromBatch = batchMap[ip] || { ...EMPTY_INFO };
      const fromIpApiJson = ipApiJsonMap[ip] || { ...EMPTY_INFO };
      const fromIpWhois = ipWhoisMap[ip] || { ...EMPTY_INFO };
      const mergedPrimary = mergeInfo(fromBatch, fromIpApiJson);
      const info = mergeInfo(mergedPrimary, fromIpWhois);
      results[ip] = info;
      if (hasGeoInfo(info)) {
        geoCache.set(ip, info);
      }
    }

    // Enrich missing fields by querying providers not used as primary for that IP.
    const needsEnrichment = uncached.filter(
      (ip) => !results[ip] || !results[ip].country || !results[ip].org
    );
    if (needsEnrichment.length > 0) {
      const enrichJsonIps = needsEnrichment.filter((ip) => !ipApiJsonSet.has(ip));
      const enrichIpWhoisIps = needsEnrichment.filter((ip) => !ipWhoisSet.has(ip));
      const [enrichJsonMap, enrichIpWhoisMap] = await Promise.all([
        lookupIpApiJsonMany(enrichJsonIps),
        lookupIpWhoisMany(enrichIpWhoisIps),
      ]);

      for (const ip of needsEnrichment) {
        const base = results[ip] || { ...EMPTY_INFO };
        const withJson = mergeInfo(base, enrichJsonMap[ip] || { ...EMPTY_INFO });
        const merged = mergeInfo(withJson, enrichIpWhoisMap[ip] || { ...EMPTY_INFO });
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
