"use client";
import { useState, useCallback, useEffect, useRef } from "react";

// ─── i18n ────────────────────────────────────────────────────────────
const STRINGS = {
  en: {
    subtitle: "Measure latency from your browser to each game server",
    startScan: "Start Scan",
    scanning: "Scanning...",
    rescan: "Rescan",
    asia: "Asia Server",
    naeu: "NA-EU Server",
    asiaTest: "Asia Test Server",
    naeuTest: "NA-EU Test Server",
    // Asia group labels
    asiaSEA: "Southeast Asia Block",
    asiaEastJP: "East Asia / Japan Block",
    // NA-EU group labels
    naeuNA: "North America Block",
    naeuEU: "Europe Block",
    matchRegion: "Match Region",
    ip: "IP Address",
    ping: "Latency",
    status: "Status",
    up: "Online",
    down: "Timeout",
    measuring: "Measuring...",
    waiting: "Waiting",
    avg: "Avg",
    best: "Best",
    worst: "Worst",
    responded: "Online",
    timeout: "Timeout",
    servers: "servers",
    skipped: "Skipped",
    noData: "No server data available",
    fetchError: "Failed to fetch server list",
    note: "Latency is measured in-browser via HTTPS fetch to port 4000. TCP handshake time from Resource Timing is used first; when unavailable, elapsed time until fetch error is used.",
    allGroupsDown: "All servers unreachable",
  },
  ja: {
    subtitle: "ブラウザから各ゲームサーバーへの遅延を測定",
    startScan: "スキャン開始",
    scanning: "スキャン中...",
    rescan: "再スキャン",
    asia: "アジアサーバー",
    naeu: "NA-EUサーバー",
    asiaTest: "アジアテストサーバー",
    naeuTest: "NA-EUテストサーバー",
    // Asia group labels
    asiaSEA: "東南アジアブロック",
    asiaEastJP: "東アジア（日本）ブロック",
    // NA-EU group labels
    naeuNA: "北米ブロック",
    naeuEU: "欧州ブロック",
    matchRegion: "マッチ地域",
    ip: "IPアドレス",
    ping: "遅延",
    status: "状態",
    up: "応答あり",
    down: "タイムアウト",
    measuring: "計測中...",
    waiting: "待機中",
    avg: "平均",
    best: "最速",
    worst: "最遅",
    responded: "応答",
    timeout: "タイムアウト",
    servers: "サーバー",
    skipped: "スキップ",
    noData: "サーバーデータを取得できません",
    fetchError: "サーバーリストの取得に失敗しました",
    note: "遅延はブラウザ内のHTTPS fetchでポート4000に対して測定しています。Resource TimingのTCP接続時間を優先し、取得できない場合はfetchエラー到達までの経過時間を使用します。",
    allGroupsDown: "全サーバー到達不可",
  },
};

function useLang() {
  const [lang, setLang] = useState("en");
  useEffect(() => {
    const browserLang = navigator.language || navigator.userLanguage || "en";
    setLang(browserLang.startsWith("ja") ? "ja" : "en");
  }, []);
  return [lang, setLang];
}

function t(lang, key) {
  return STRINGS[lang]?.[key] || STRINGS.en[key] || key;
}

// Get human-readable group label based on region and group letter
function getGroupLabel(lang, regionId, group) {
  if (regionId === "asianormal") {
    if (group === "A") return t(lang, "asiaSEA");
    if (group === "B") return t(lang, "asiaEastJP");
  }
  // NA-EU: A = North America, B = Europe
  if (group === "A") return t(lang, "naeuNA");
  if (group === "B") return t(lang, "naeuEU");
  return group;
}

// ─── IP Geolocation ─────────────────────────────────────────────────
// Uses server-side proxy (/api/geo) which calls ip-api.com batch endpoint
// and caches results in server memory. This avoids CORS issues on some
// deployments and provides fast cached lookups on repeat scans.
const geoCache = new Map();

// Convert country code to flag emoji (regional indicator symbols)
function countryToFlag(code) {
  if (!code || code.length !== 2) return "";
  const offset = 0x1f1e6 - 65; // 'A' = 65
  return String.fromCodePoint(
    code.charCodeAt(0) + offset,
    code.charCodeAt(1) + offset
  );
}

// Batched geo lookup: collects IPs and flushes in a single server-side batch
const geoQueue = {
  pending: new Set(),
  timer: null,
  callback: null,
  enqueue(ip) {
    if (geoCache.has(ip)) {
      if (this.callback) this.callback(ip, geoCache.get(ip));
      return;
    }
    this.pending.add(ip);
    // Debounce: flush batch after short delay to collect multiple IPs
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 300);
  },
  async flush() {
    if (this.pending.size === 0) return;
    const ips = [...this.pending];
    this.pending.clear();

    // Filter out already cached
    const uncached = ips.filter((ip) => !geoCache.has(ip));
    // Emit cached ones immediately
    for (const ip of ips) {
      if (geoCache.has(ip) && this.callback) {
        this.callback(ip, geoCache.get(ip));
      }
    }

    if (uncached.length === 0) return;

    try {
      const res = await fetch("/api/geo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ips: uncached }),
      });
      if (!res.ok) throw new Error("batch geo failed");
      const { results } = await res.json();
      for (const ip of uncached) {
        const r = results[ip] || {};
        const info = {
          flag: countryToFlag((r.country_code || "").toUpperCase()),
          country: r.country || "",
          org: r.org || "",
        };
        geoCache.set(ip, info);
        if (this.callback) this.callback(ip, info);
      }
    } catch {
      // Mark all as empty on failure
      for (const ip of uncached) {
        const empty = { flag: "", country: "", org: "" };
        geoCache.set(ip, empty);
        if (this.callback) this.callback(ip, empty);
      }
    }
  },
};

// ─── Ping measurement ───────────────────────────────────────────────
// Browser-only measurement via HTTPS fetch + Resource Timing API.
// No prediction/correction is applied.
const MIN_VALID_PING_MS = 1;
const MAX_VALID_PING_MS = 4000;
const REQUEST_TIMEOUT_MS = 4000;

async function measurePing(ip, port = 4000, attempts = 3) {
  const results = [];

  for (let i = 0; i < attempts; i++) {
    const url = `https://${ip}:${port}/?_=${Date.now()}_${i}_${Math.random()}`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);

    try {
      const rtPromise = new Promise((resolve) => {
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (entry.name === url) {
              observer.disconnect();
              resolve(entry);
              return;
            }
          }
        });
        observer.observe({ type: "resource", buffered: true });
        setTimeout(() => {
          observer.disconnect();
          resolve(null);
        }, 5000);
      });

      let fetchErrorName = "";
      const t0 = performance.now();
      await fetch(url, {
        mode: "no-cors",
        cache: "no-store",
        signal: ac.signal,
      }).catch((err) => {
        fetchErrorName = err?.name || "";
      });
      const wallTime = performance.now() - t0;

      const entry = await rtPromise;
      let sample = null;
      if (entry) {
        const tcp = entry.connectEnd - entry.connectStart;
        if (tcp >= MIN_VALID_PING_MS && tcp < MAX_VALID_PING_MS) {
          sample = tcp;
        } else if (entry.responseStart > 0 && entry.requestStart > 0) {
          const ttfb = entry.responseStart - entry.requestStart;
          if (ttfb >= MIN_VALID_PING_MS && ttfb < MAX_VALID_PING_MS) {
            sample = ttfb;
          }
        }
      }
      if (sample === null) {
        const likelyAbort =
          ac.signal.aborted ||
          fetchErrorName === "AbortError" ||
          wallTime >= REQUEST_TIMEOUT_MS - 20;
        if (
          !likelyAbort &&
          wallTime >= MIN_VALID_PING_MS &&
          wallTime < MAX_VALID_PING_MS
        ) {
          sample = wallTime;
        }
      }

      if (sample !== null) {
        results.push(sample);
      }
    } catch {
      // timeout or network error
    }

    clearTimeout(timer);
    performance.clearResourceTimings();

    if (i < attempts - 1) {
      await new Promise((r) => setTimeout(r, 30));
    }
  }

  if (results.length === 0) return null;
  results.sort((a, b) => a - b);
  const median = results[Math.floor(results.length / 2)];
  return Math.max(1, Math.round(median));
}

// ─── Region definitions ─────────────────────────────────────────────
const REGIONS = [
  { id: "asianormal", labelKey: "asia", hasGroups: true },
  { id: "usnormal", labelKey: "naeu", hasGroups: true },
  // Test servers — kept for reference but disabled from display
  { id: "asiatest", labelKey: "asiaTest", hasGroups: false, disabled: true },
  { id: "ustest", labelKey: "naeuTest", hasGroups: false, disabled: true },
];

const ACTIVE_REGIONS = REGIONS.filter((r) => !r.disabled);

// ─── Main component ─────────────────────────────────────────────────
export default function Home() {
  const [lang, setLang] = useLang();
  const [scanning, setScanning] = useState(false);
  const [hasScanned, setHasScanned] = useState(false);
  const [regionData, setRegionData] = useState({});
  const [geoInfo, setGeoInfo] = useState({}); // { [ip]: { flag, country, org } }

  // Ref so ping callbacks can trigger geo lookups without stale closure
  const geoSetterRef = useRef(setGeoInfo);
  geoSetterRef.current = setGeoInfo;

  const startScan = useCallback(async () => {
    setScanning(true);
    setHasScanned(true);
    const newData = {};

    // Set up geo queue callback to update state as results arrive
    geoQueue.callback = (ip, info) => {
      geoSetterRef.current((prev) => ({ ...prev, [ip]: info }));
    };

    // Fire-and-forget geo lookup for a server that responded
    const triggerGeo = (ip) => {
      geoQueue.enqueue(ip);
    };

    // Fetch all server lists in parallel
    const fetches = await Promise.allSettled(
      ACTIVE_REGIONS.map(async (region) => {
        try {
          const res = await fetch(`/api/servers?region=${region.id}`);
          const json = await res.json();
          return { regionId: region.id, servers: json.servers || [] };
        } catch {
          return { regionId: region.id, servers: [], error: true };
        }
      })
    );

    for (const result of fetches) {
      if (result.status === "fulfilled") {
        const { regionId, servers, error } = result.value;
        newData[regionId] = {
          servers: servers.map((s) => ({
            ...s,
            ping: null,
            status: "waiting",
          })),
          activeGroup: null,
          error: !!error,
          done: false,
        };
      }
    }

    setRegionData({ ...newData });

    // Ping all regions in parallel, geo lookups triggered as pings complete
    await Promise.all(
      ACTIVE_REGIONS.map((region) =>
        pingRegion(region, newData, (updated) =>
          setRegionData((prev) => ({ ...prev, ...updated })),
          triggerGeo
        )
      )
    );

    setScanning(false);
  }, []);

  return (
    <div style={styles.page}>
      <div className="container" style={styles.container}>
        {/* Header */}
        <header className="header" style={styles.header}>
          <h1 className="title" style={styles.title}>Identity V Game Server Ping Checker</h1>
          <p className="subtitle" style={styles.subtitle}>{t(lang, "subtitle")}</p>
          <div className="header-actions" style={styles.headerActions}>
            <button
              className="scan-btn"
              style={scanning ? styles.btnDisabled : styles.btn}
              onClick={startScan}
              disabled={scanning}
            >
              {scanning
                ? t(lang, "scanning")
                : hasScanned
                  ? t(lang, "rescan")
                  : t(lang, "startScan")}
            </button>
            <button
              className="lang-btn"
              style={styles.langBtn}
              onClick={() => setLang(lang === "en" ? "ja" : "en")}
            >
              {lang === "en" ? "日本語" : "English"}
            </button>
          </div>
        </header>

        {/* Region panels */}
        <div className="grid" style={styles.grid}>
          {ACTIVE_REGIONS.map((region) => (
            <RegionPanel
              key={region.id}
              region={region}
              data={regionData[region.id]}
              lang={lang}
              scanning={scanning}
              geoInfo={geoInfo}
            />
          ))}
        </div>

        {/* Footer note */}
        {hasScanned && <p style={styles.note}>{t(lang, "note")}</p>}
      </div>
    </div>
  );
}

// ─── Ping a single region ────────────────────────────────────────────
async function pingRegion(region, dataRef, onUpdate, triggerGeo) {
  const data = dataRef[region.id];
  if (!data || data.servers.length === 0) {
    onUpdate({
      [region.id]: { ...data, done: true },
    });
    return;
  }

  const servers = [...data.servers];
  const hasGroups = region.hasGroups;

  if (hasGroups) {
    // Separate into groups
    const groupA = [];
    const groupB = [];
    servers.forEach((s, i) => {
      if (s.group === "A") groupA.push({ ...s, index: i });
      else if (s.group === "B") groupB.push({ ...s, index: i });
      else groupA.push({ ...s, index: i });
    });

    // Ping both groups in parallel with early termination
    const groupAResults = { timeouts: 0, ups: 0, results: [] };
    const groupBResults = { timeouts: 0, ups: 0, results: [] };

    // Asia: 3 timeouts to detect dead group, NA-EU: 5
    const timeoutThreshold = region.id === "asianormal" ? 3 : 5;

    const pingGroup = async (items, stats, otherStats) => {
      for (const server of items) {
        // Early termination: N timeouts in this group + 3 ups in other group
        if (stats.timeouts >= timeoutThreshold && otherStats.ups >= 3) {
          // Mark remaining as skipped (they belong to dead group)
          const currentIdx = items.indexOf(server);
          for (let j = currentIdx; j < items.length; j++) {
            stats.results.push({
              index: items[j].index,
              ping: null,
              status: "skipped",
            });
          }
          break;
        }

        // Mark as measuring
        updateServer(
          region.id,
          server.index,
          { status: "measuring" },
          onUpdate,
          dataRef
        );

        const ping = await measurePing(server.ip, server.port);
        const status = ping !== null ? "done" : "timeout";

        if (ping !== null) stats.ups++;
        else stats.timeouts++;

        stats.results.push({ index: server.index, ping, status });
        updateServer(
          region.id,
          server.index,
          { ping, status },
          onUpdate,
          dataRef
        );

        // Trigger geo lookup immediately for servers that responded
        if (ping !== null && triggerGeo) triggerGeo(server.ip);
      }
    };

    await Promise.all([
      pingGroup(groupA, groupAResults, groupBResults),
      pingGroup(groupB, groupBResults, groupAResults),
    ]);

    // Determine active group(s)
    let activeGroup = null;
    const aUps = groupAResults.ups;
    const bUps = groupBResults.ups;

    if (aUps > 0 && bUps === 0) activeGroup = "A";
    else if (bUps > 0 && aUps === 0) activeGroup = "B";
    else if (aUps > 0 && bUps > 0) activeGroup = "A+B";
    // else both down

    // Update final state
    const finalServers = [...dataRef[region.id].servers];
    [...groupAResults.results, ...groupBResults.results].forEach((r) => {
      finalServers[r.index] = {
        ...finalServers[r.index],
        ping: r.ping,
        status: r.status,
      };
    });

    dataRef[region.id] = {
      ...dataRef[region.id],
      servers: finalServers,
      activeGroup,
      done: true,
    };
    onUpdate({ [region.id]: dataRef[region.id] });
  } else {
    // No groups (test servers) — ping all sequentially
    for (let i = 0; i < servers.length; i++) {
      updateServer(
        region.id,
        i,
        { status: "measuring" },
        onUpdate,
        dataRef
      );
      const ping = await measurePing(servers[i].ip, servers[i].port);
      const status = ping !== null ? "done" : "timeout";
      updateServer(region.id, i, { ping, status }, onUpdate, dataRef);
      if (ping !== null && triggerGeo) triggerGeo(servers[i].ip);
    }
    dataRef[region.id] = { ...dataRef[region.id], done: true };
    onUpdate({ [region.id]: dataRef[region.id] });
  }
}

function updateServer(regionId, index, updates, onUpdate, dataRef) {
  const current = dataRef[regionId];
  const servers = [...current.servers];
  servers[index] = { ...servers[index], ...updates };
  dataRef[regionId] = { ...current, servers };
  onUpdate({ [regionId]: dataRef[regionId] });
}

// ─── Region Panel Component ─────────────────────────────────────────
function RegionPanel({ region, data, lang, scanning, geoInfo }) {
  if (!data) {
    return (
      <div style={styles.panel}>
        <div style={styles.panelHeader}>
          <h2 style={styles.panelTitle}>{t(lang, region.labelKey)}</h2>
        </div>
        <div style={styles.panelBody}>
          <p style={styles.emptyText}>
            {scanning ? t(lang, "measuring") : "—"}
          </p>
        </div>
      </div>
    );
  }

  if (data.error) {
    return (
      <div style={styles.panel}>
        <div style={styles.panelHeader}>
          <h2 style={styles.panelTitle}>{t(lang, region.labelKey)}</h2>
        </div>
        <div style={styles.panelBody}>
          <p style={styles.errorText}>{t(lang, "fetchError")}</p>
        </div>
      </div>
    );
  }

  const servers = data.servers || [];
  const hasGroups = region.hasGroups;
  const activeGroup = data.activeGroup;

  // For grouped regions: only show active group servers, hide dead group entirely
  let displayServers = servers;
  if (hasGroups && activeGroup && activeGroup !== "A+B") {
    // Only one group active — show only that group
    displayServers = servers.filter((s) => s.group === activeGroup);
  } else if (hasGroups && data.done && !activeGroup) {
    // Both groups dead
    displayServers = [];
  }
  // If A+B: show all (both active)

  // Sort: servers with ping results first (by ping asc), then in-progress, then timeouts
  displayServers = [...displayServers].sort((a, b) => {
    const order = (s) => {
      if (s.ping !== null) return 0;          // responded — top
      if (s.status === "measuring") return 1; // in progress
      if (s.status === "waiting") return 2;   // queued
      return 3;                                // timeout/skipped — bottom
    };
    const oa = order(a);
    const ob = order(b);
    if (oa !== ob) return oa - ob;
    // Within responded servers, sort by ping ascending
    if (a.ping !== null && b.ping !== null) return a.ping - b.ping;
    return 0;
  });

  // Stats (only from displayed servers)
  const doneServers = displayServers.filter(
    (s) => s.status === "done" || s.status === "timeout"
  );
  const upServers = doneServers.filter((s) => s.ping !== null);
  const avgPing =
    upServers.length > 0
      ? Math.round(
          upServers.reduce((a, s) => a + s.ping, 0) / upServers.length
        )
      : null;
  const bestPing =
    upServers.length > 0 ? Math.min(...upServers.map((s) => s.ping)) : null;
  const worstPing =
    upServers.length > 0 ? Math.max(...upServers.map((s) => s.ping)) : null;

  // Group label for badge
  let groupBadgeText = null;
  if (hasGroups && activeGroup && activeGroup !== "A+B") {
    groupBadgeText = `${t(lang, "matchRegion")}: ${getGroupLabel(lang, region.id, activeGroup)}`;
  } else if (hasGroups && activeGroup === "A+B") {
    const labelA = getGroupLabel(lang, region.id, "A");
    const labelB = getGroupLabel(lang, region.id, "B");
    groupBadgeText = `${t(lang, "matchRegion")}: ${labelA} + ${labelB}`;
  }

  return (
    <div style={styles.panel}>
      <div style={styles.panelHeader}>
        <div style={styles.panelTitleRow}>
          <h2 style={styles.panelTitle}>{t(lang, region.labelKey)}</h2>
        </div>
        {groupBadgeText && (
          <div style={styles.groupBadgeRow}>
            <span style={styles.groupBadge}>{groupBadgeText}</span>
          </div>
        )}
        {/* Stats bar (only for non-test servers with multiple IPs) */}
        {hasGroups && doneServers.length > 0 && (
          <div className="stats-bar" style={styles.statsBar}>
            <Stat
              label={t(lang, "responded")}
              value={upServers.length}
              accent={upServers.length > 0 ? "#a0a0a0" : "#666"}
            />
            <Stat
              label={t(lang, "timeout")}
              value={doneServers.length - upServers.length}
              accent="#666"
            />
            {avgPing !== null && (
              <Stat
                label={t(lang, "avg")}
                value={`${avgPing}ms`}
                accent="#a0a0a0"
              />
            )}
            {bestPing !== null && (
              <Stat
                label={t(lang, "best")}
                value={`${bestPing}ms`}
                accent="#fff"
              />
            )}
            {worstPing !== null && (
              <Stat
                label={t(lang, "worst")}
                value={`${worstPing}ms`}
                accent="#555"
              />
            )}
          </div>
        )}
      </div>

      <div style={styles.panelBody}>
        {data.done && displayServers.length === 0 ? (
          <p style={styles.emptyText}>{t(lang, "allGroupsDown")}</p>
        ) : (
          <div style={styles.serverList}>
            {displayServers.map((server, i) => (
              <ServerRow
                key={`${server.ip}-${i}`}
                server={server}
                lang={lang}
                geo={geoInfo?.[server.ip]}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, accent }) {
  return (
    <div style={styles.stat}>
      <span style={styles.statLabel}>{label}</span>
      <span style={{ ...styles.statValue, color: accent }}>{value}</span>
    </div>
  );
}

function ServerRow({ server, lang, geo }) {
  const { ip, ping, status } = server;

  let pingDisplay;
  let pingStyle = styles.pingValue;

  if (status === "measuring") {
    pingDisplay = t(lang, "measuring");
    pingStyle = { ...styles.pingValue, color: "#555" };
  } else if (status === "waiting") {
    pingDisplay = t(lang, "waiting");
    pingStyle = { ...styles.pingValue, color: "#444" };
  } else if (status === "skipped") {
    pingDisplay = t(lang, "skipped");
    pingStyle = { ...styles.pingValue, color: "#444" };
  } else if (ping !== null) {
    pingDisplay = `${ping}ms`;
    if (ping < 50) pingStyle = { ...styles.pingValue, color: "#fff" };
    else if (ping < 100) pingStyle = { ...styles.pingValue, color: "#aaa" };
    else pingStyle = { ...styles.pingValue, color: "#666" };
  } else {
    pingDisplay = t(lang, "down");
    pingStyle = { ...styles.pingValue, color: "#555" };
  }

  // Ping bar width (max 300ms for visual scale)
  const barWidth = ping !== null ? Math.min((ping / 300) * 100, 100) : 0;
  const barColor =
    ping !== null
      ? ping < 50
        ? "#fff"
        : ping < 100
          ? "#888"
          : "#555"
      : "transparent";

  // Show geo info only for servers that responded
  const showGeo = ping !== null && geo && (geo.flag || geo.country);

  return (
    <div className="server-row" style={styles.serverRow}>
      <div className="server-info" style={styles.serverInfo}>
        <span style={styles.serverIp}>{ip}</span>
        {showGeo && (
          <span className="geo-info" style={styles.geoInfo}>
            {geo.flag && <span style={styles.geoFlag}>{geo.flag}</span>}
            {geo.country && (
              <span style={styles.geoCountry}>{geo.country}</span>
            )}
            {geo.org && <span style={styles.geoOrg}>{geo.org}</span>}
          </span>
        )}
      </div>
      <div className="ping-section" style={styles.pingSection}>
        <div style={styles.pingBar}>
          <div
            style={{
              ...styles.pingBarFill,
              width: `${barWidth}%`,
              backgroundColor: barColor,
            }}
          />
        </div>
        <span style={pingStyle}>{pingDisplay}</span>
      </div>
    </div>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────
const styles = {
  page: {
    fontFamily: "'Inter', -apple-system, 'Segoe UI', sans-serif",
    background: "#0a0a0a",
    color: "#e0e0e0",
    minHeight: "100vh",
  },
  container: {
    maxWidth: 1200,
    margin: "0 auto",
    padding: "24px 16px",
  },
  header: {
    marginBottom: 40,
    borderBottom: "1px solid #1a1a1a",
    paddingBottom: 32,
  },
  title: {
    fontSize: 20,
    fontWeight: 600,
    color: "#ffffff",
    margin: 0,
    letterSpacing: "-0.02em",
  },
  subtitle: {
    fontSize: 14,
    color: "#666",
    margin: "8px 0 20px 0",
    fontWeight: 400,
  },
  headerActions: {
    display: "flex",
    gap: 12,
    alignItems: "center",
  },
  btn: {
    background: "#fff",
    color: "#000",
    border: "none",
    padding: "10px 24px",
    borderRadius: 6,
    cursor: "pointer",
    fontWeight: 600,
    fontSize: 13,
    fontFamily: "'Inter', sans-serif",
    transition: "opacity 0.15s",
  },
  btnDisabled: {
    background: "#1a1a1a",
    color: "#444",
    border: "1px solid #222",
    padding: "10px 24px",
    borderRadius: 6,
    cursor: "not-allowed",
    fontWeight: 600,
    fontSize: 13,
    fontFamily: "'Inter', sans-serif",
  },
  langBtn: {
    background: "transparent",
    color: "#666",
    border: "1px solid #222",
    padding: "10px 16px",
    borderRadius: 6,
    cursor: "pointer",
    fontWeight: 500,
    fontSize: 13,
    fontFamily: "'Inter', sans-serif",
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(0, 1fr))",
    gap: 20,
  },
  // Panel
  panel: {
    background: "#111",
    border: "1px solid #1a1a1a",
    borderRadius: 10,
    overflow: "hidden",
  },
  panelHeader: {
    padding: "16px 12px",
    borderBottom: "1px solid #1a1a1a",
  },
  panelTitleRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  panelTitle: {
    fontSize: 15,
    fontWeight: 600,
    color: "#ccc",
    margin: 0,
  },
  groupBadgeRow: {
    marginTop: 8,
  },
  groupBadge: {
    fontSize: 11,
    fontWeight: 500,
    color: "#888",
    background: "#1a1a1a",
    padding: "4px 10px",
    borderRadius: 4,
    fontFamily: "'JetBrains Mono', monospace",
    display: "inline-block",
  },
  statsBar: {
    display: "flex",
    gap: 20,
    marginTop: 12,
  },
  stat: {
    display: "flex",
    flexDirection: "column",
    gap: 2,
  },
  statLabel: {
    fontSize: 10,
    fontWeight: 500,
    color: "#555",
    textTransform: "uppercase",
    letterSpacing: "0.05em",
  },
  statValue: {
    fontSize: 14,
    fontWeight: 600,
    fontFamily: "'JetBrains Mono', monospace",
  },
  panelBody: {
    padding: "0",
    maxHeight: 600,
    overflowY: "auto",
  },
  emptyText: {
    color: "#444",
    fontSize: 13,
    textAlign: "center",
    padding: "32px 20px",
    margin: 0,
  },
  errorText: {
    color: "#666",
    fontSize: 13,
    textAlign: "center",
    padding: "32px 20px",
    margin: 0,
  },
  // Server list
  serverList: {
    display: "flex",
    flexDirection: "column",
  },
  serverRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "8px 12px",
    borderBottom: "1px solid #151515",
    gap: 16,
  },
  serverInfo: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    minWidth: 0,
    flex: 1,
    overflow: "hidden",
  },
  serverIp: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 12,
    color: "#888",
    fontWeight: 400,
    flexShrink: 0,
  },
  geoInfo: {
    display: "flex",
    alignItems: "center",
    gap: 5,
    minWidth: 0,
    overflow: "hidden",
  },
  geoFlag: {
    fontSize: 13,
    flexShrink: 0,
  },
  geoCountry: {
    fontSize: 11,
    color: "#777",
    fontWeight: 400,
    whiteSpace: "nowrap",
    flexShrink: 0,
  },
  geoOrg: {
    fontSize: 10,
    color: "#555",
    fontWeight: 400,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    minWidth: 0,
  },
  pingSection: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    flexShrink: 0,
    minWidth: 100,
  },
  pingBar: {
    width: 60,
    height: 3,
    background: "#1a1a1a",
    borderRadius: 2,
    overflow: "hidden",
    flexShrink: 0,
  },
  pingBarFill: {
    height: "100%",
    borderRadius: 2,
    transition: "width 0.3s ease",
  },
  pingValue: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 12,
    fontWeight: 500,
    minWidth: 64,
    textAlign: "right",
  },
  // Note
  note: {
    color: "#444",
    fontSize: 11,
    marginTop: 32,
    lineHeight: 1.6,
    borderTop: "1px solid #1a1a1a",
    paddingTop: 20,
  },
};
