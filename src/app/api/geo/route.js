// Server-side geo lookup with in-memory cache using ip-api.com batch endpoint
// POST /api/geo  body: { ips: ["1.2.3.4", "5.6.7.8"] }
// Returns: { results: { "1.2.3.4": { country_code, country, org }, ... } }

const geoCache = new Map();

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

  // Validate IPs
  const ipRegex = /^\d{1,3}(\.\d{1,3}){3}$/;
  const validIps = ips.filter((ip) => typeof ip === "string" && ipRegex.test(ip));

  // Separate cached and uncached
  const results = {};
  const uncached = [];

  for (const ip of validIps) {
    if (geoCache.has(ip)) {
      results[ip] = geoCache.get(ip);
    } else {
      uncached.push(ip);
    }
  }

  // Fetch uncached IPs from ip-api.com batch endpoint
  if (uncached.length > 0) {
    try {
      const res = await fetch("http://ip-api.com/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          uncached.map((ip) => ({
            query: ip,
            fields: "status,country,countryCode,org,isp,query",
          }))
        ),
      });

      if (!res.ok) throw new Error(`ip-api.com returned ${res.status}`);

      const batchResults = await res.json();
      for (const r of batchResults) {
        const ip = r.query;
        const info =
          r.status === "success"
            ? {
                country_code: (r.countryCode || "").toUpperCase(),
                country: r.country || "",
                org: r.org || r.isp || "",
              }
            : { country_code: "", country: "", org: "" };

        geoCache.set(ip, info);
        results[ip] = info;
      }
    } catch (e) {
      // On failure, return empty for uncached IPs
      for (const ip of uncached) {
        if (!results[ip]) {
          results[ip] = { country_code: "", country: "", org: "" };
        }
      }
    }
  }

  return Response.json({ results });
}
