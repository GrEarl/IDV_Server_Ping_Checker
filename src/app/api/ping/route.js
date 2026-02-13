import { Socket } from "node:net";
import { performance } from "node:perf_hooks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MIN_PORT = 1;
const MAX_PORT = 65535;
const DEFAULT_PORT = 4000;
const DEFAULT_ATTEMPTS = 3;
const MAX_ATTEMPTS = 5;
const DEFAULT_TIMEOUT_MS = 2500;
const INTERVAL_BETWEEN_ATTEMPTS_MS = 30;
const VALID_IP_REGEX =
  /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function validateIp(ip) {
  return typeof ip === "string" && VALID_IP_REGEX.test(ip);
}

function measureTcpConnectOnce(ip, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = new Socket();
    socket.setNoDelay(true);
    socket.setTimeout(timeoutMs);

    const started = performance.now();
    let settled = false;

    const finalize = (result) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };

    socket.once("connect", () => {
      const elapsed = performance.now() - started;
      finalize(elapsed > 0 ? elapsed : null);
    });
    socket.once("timeout", () => finalize(null));
    socket.once("error", () => finalize(null));

    socket.connect(port, ip);
  });
}

async function measureTcpConnectMedian(ip, port, attempts, timeoutMs) {
  const samples = [];

  for (let i = 0; i < attempts; i++) {
    const sample = await measureTcpConnectOnce(ip, port, timeoutMs);
    if (sample !== null && Number.isFinite(sample)) {
      samples.push(sample);
    }
    if (i < attempts - 1) {
      await sleep(INTERVAL_BETWEEN_ATTEMPTS_MS);
    }
  }

  if (samples.length === 0) {
    return { ping: null, samples: [] };
  }

  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)];
  return {
    ping: Math.max(1, Math.round(median)),
    samples: samples.map((v) => Math.round(v * 100) / 100),
  };
}

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }

  const ip = body?.ip;
  if (!validateIp(ip)) {
    return Response.json({ error: "invalid ip" }, { status: 400 });
  }

  const rawPort = Number(body?.port ?? DEFAULT_PORT);
  if (!Number.isInteger(rawPort) || rawPort < MIN_PORT || rawPort > MAX_PORT) {
    return Response.json({ error: "invalid port" }, { status: 400 });
  }

  const attempts = clamp(
    Number.isInteger(Number(body?.attempts))
      ? Number(body.attempts)
      : DEFAULT_ATTEMPTS,
    1,
    MAX_ATTEMPTS
  );
  const timeoutMs = clamp(
    Number.isInteger(Number(body?.timeoutMs))
      ? Number(body.timeoutMs)
      : DEFAULT_TIMEOUT_MS,
    500,
    10000
  );

  const result = await measureTcpConnectMedian(ip, rawPort, attempts, timeoutMs);
  return Response.json(
    {
      ...result,
      source: "server-tcp-connect",
      attempts,
      timeoutMs,
    },
    {
      headers: {
        "Cache-Control": "no-store, max-age=0",
      },
    }
  );
}
