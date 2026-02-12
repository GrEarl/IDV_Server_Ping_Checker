// Proxy for fetching game server lists (HTTP-only origins, no CORS)
// GET /api/servers?region=asianormal|asiatest|usnormal|ustest

const URLS = {
  asianormal:
    "http://h55na.update.easebar.com/server_list_asianormal_game.txt",
  asiatest: "http://h55na.update.easebar.com/server_list_asiatest_game.txt",
  usnormal: "http://h55na.update.easebar.com/server_list_usnormal_game.txt",
  ustest: "http://h55na.update.easebar.com/server_list_ustest_game.txt",
};

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const region = searchParams.get("region");

  if (!region || !URLS[region]) {
    return Response.json(
      { error: "invalid region", valid: Object.keys(URLS) },
      { status: 400 }
    );
  }

  try {
    const res = await fetch(URLS[region], {
      next: { revalidate: 300 }, // cache 5 min
    });
    const text = await res.text();
    const servers = parseServerList(text);
    return Response.json({ region, servers });
  } catch (e) {
    return Response.json(
      { error: "fetch failed", detail: e.message },
      { status: 502 }
    );
  }
}

function parseServerList(text) {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));

  const servers = [];
  for (const line of lines) {
    // Format: ID TYPE IP PORT VAL1 VAL2 NUM1 NUM2 GROUP
    // e.g. "10001 5 34.84.21.129 4000 12 10 2614959 2634973  A"
    // Test servers may not have the group letter
    const parts = line.split(/\s+/).filter(Boolean);
    if (parts.length < 4) continue;

    const ip = parts[2];
    const port = parseInt(parts[3], 10);

    // Validate IP
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) continue;
    // Only include port 4000-4999
    if (port < 4000 || port > 4999) continue;

    const group = parts.length >= 9 ? parts[8] : null;
    const serverId = parts[0];

    servers.push({ ip, port, group, serverId });
  }

  return servers;
}
