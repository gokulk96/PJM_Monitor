import http from "node:http";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");

loadDotEnv(path.join(__dirname, ".env"));

const PORT = Number(process.env.PORT || 3000);
const ACCESS_TOKEN = process.env.ACCESS_TOKEN || "";
const PJM_BASE_URL = (process.env.PJM_API_BASE_URL || "https://api.pjm.com/api/v1").replace(/\/$/, "");
const PJM_API_KEY = process.env.PJM_API_KEY || "";
const PJM_AUTH_MODE = (process.env.PJM_AUTH_MODE || "header").toLowerCase();
const PJM_TIMEOUT_SECONDS = Number(process.env.PJM_TIMEOUT_SECONDS || 30);
const PJM_RATE_LIMIT_PER_MINUTE = Number(process.env.PJM_RATE_LIMIT_PER_MINUTE || 6);
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "google/gemini-2.5-flash";

const ZONE_PNODES = {
  "PJM-RTO": 1,
  AECO: 51291,
  AEP: 8445784,
  APS: 8394954,
  ATSI: 116013753,
  BGE: 51292,
  COMED: 33092371,
  DAY: 34508503,
  DAYTON: 34508503,
  DEOK: 124076095,
  DOM: 34964545,
  DPL: 51293,
  DUQ: 37737283,
  EKPC: 970242670,
  JCPL: 51295,
  METED: 51296,
  OVEC: 1709725933,
  PECO: 51297,
  PENELEC: 51300,
  PEPCO: 51298,
  PPL: 51299,
  PSEG: 51301,
  RECO: 7633629
};

const RENEWABLE_AREAS = ["RTO", "MIDATL", "RFC", "SOUTH", "WEST", "OTHER"];
const cache = new Map();
const rateState = { windowStart: Date.now(), count: 0 };

// Load pnodes.csv at startup for autocomplete search
let pnodesData = [];
try {
  const csvText = readFileSync(path.join(__dirname, "pnodes.csv"), "utf8");
  const lines = csvText.split(/\r?\n/).slice(1);
  pnodesData = lines.filter(Boolean).map(line => {
    const cols = line.split(",");
    return { id: (cols[0] || "").trim(), name: (cols[1] || "").trim(), type: (cols[2] || "").trim(), zone: (cols[4] || "").trim(), voltage: (cols[5] || "").trim() };
  }).filter(p => p.id && p.name);
  console.log(`Loaded ${pnodesData.length} pnodes from pnodes.csv`);
} catch (e) {
  console.warn("pnodes.csv not found:", e.message);
}

const routes = {
  "/api/pjm/status": handleStatus,
  "/api/pjm/pnodes": handlePnodes,
  "/api/pjm/da-lmp/zone": handleZoneLmp,
  "/api/pjm/rt-lmp/zone": handleZoneRtLmp,
  "/api/pjm/constraints/transmission": handleTransmissionConstraints,
  "/api/pjm/constraints/binding": handleBindingConstraints,
  "/api/pjm/constraints/rt-binding": handleRtBindingConstraints,
  "/api/pjm/renewables": handleRenewables,
  "/api/analysis": handleAnalysis
};

function checkAuth(req, res) {
  if (!ACCESS_TOKEN) return true;
  const auth = req.headers["authorization"] || "";
  if (auth === `Bearer ${ACCESS_TOKEN}`) return true;
  res.writeHead(401, { "WWW-Authenticate": 'Bearer realm="PJM Monitor"', "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Unauthorized" }));
  return false;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (url.pathname in routes) {
      if (!checkAuth(req, res)) return;
      await routes[url.pathname](req, res, url);
      return;
    }
    await serveStatic(res, url.pathname);
  } catch (error) {
    sendJson(res, 500, { error: "Internal server error", detail: error.message });
  }
});

server.listen(PORT, () => {
  console.log(`PJM Market Analyst running at http://localhost:${PORT}`);
});

async function handleStatus(_req, res) {
  sendJson(res, 200, {
    ok: true,
    pjmBaseUrl: PJM_BASE_URL,
    pjmApiKeyConfigured: Boolean(PJM_API_KEY),
    openRouterConfigured: Boolean(process.env.OPENROUTER_API_KEY),
    openRouterModel: OPENROUTER_MODEL,
    zones: Object.keys(ZONE_PNODES),
    renewableAreas: RENEWABLE_AREAS
  });
}

async function handlePnodes(_req, res, url) {
  const q = (url.searchParams.get("q") || "").trim();
  if (!q) { sendJson(res, 200, { results: [] }); return; }

  let results;
  if (/^\d+$/.test(q)) {
    results = pnodesData.filter(p => p.id.startsWith(q));
    results.sort((a, b) => (a.id === q ? -1 : b.id === q ? 1 : a.id.length - b.id.length));
  } else {
    const lower = q.toLowerCase();
    const sw = [], inc = [];
    for (const p of pnodesData) {
      const nl = p.name.toLowerCase();
      if (nl.startsWith(lower)) sw.push(p);
      else if (nl.includes(lower)) inc.push(p);
    }
    results = [...sw, ...inc];
  }
  sendJson(res, 200, { results: results.slice(0, 20).map(p => ({ id: p.id, name: p.name, zone: p.zone, voltage: p.voltage, type: p.type })) });
}

async function handleZoneLmp(_req, res, url) {
  const zone = cleanUpper(url.searchParams.get("zone") || "PSEG");
  const date = requireDate(url.searchParams.get("date"));
  const pnodeId = Number(url.searchParams.get("pnode_id") || ZONE_PNODES[zone]);
  if (!pnodeId) {
    sendJson(res, 400, { error: `Unknown zone '${zone}'. Use pnode_id for custom locations.` });
    return;
  }

  const rows = await getPjmRows("da_hrl_lmps", {
    row_is_current: "true",
    pnode_id: String(pnodeId),
    datetime_beginning_ept: marketDayRange(date)
  });

  const normalized = rows.filter((row) => isSelectedDate(row.datetime_beginning_ept, date)).map((row) => ({
    datetime_beginning_ept: row.datetime_beginning_ept,
    datetime_beginning_utc: row.datetime_beginning_utc,
    pnode_id: numeric(row.pnode_id),
    pnode_name: row.pnode_name,
    zone: row.zone || zone,
    total_lmp_da: numeric(row.total_lmp_da),
    system_energy_price_da: numeric(row.system_energy_price_da),
    congestion_price_da: numeric(row.congestion_price_da),
    marginal_loss_price_da: numeric(row.marginal_loss_price_da)
  })).sort(byHour);

  sendJson(res, 200, {
    zone,
    pnodeId,
    date,
    summary: summarizeLmp(normalized),
    rows: normalized
  });
}

async function handleZoneRtLmp(_req, res, url) {
  const zone = cleanUpper(url.searchParams.get("zone") || "PSEG");
  const date = requireDate(url.searchParams.get("date"));
  const gran = url.searchParams.get("granularity") || "hourly";
  const pnodeId = Number(url.searchParams.get("pnode_id") || ZONE_PNODES[zone]);
  if (!pnodeId) {
    sendJson(res, 400, { error: `Unknown zone '${zone}'. Use pnode_id for custom locations.` });
    return;
  }
  const feed = gran === "five_minute" ? "rt_fivemin_hrl_lmps" : "rt_hrl_lmps";
  const rows = await getPjmRows(feed, {
    row_is_current: "true",
    pnode_id: String(pnodeId),
    datetime_beginning_ept: marketDayRange(date)
  });
  const normalized = rows
    .filter(row => isSelectedDate(row.datetime_beginning_ept, date))
    .map(row => ({
      datetime_beginning_ept: row.datetime_beginning_ept,
      pnode_id: numeric(row.pnode_id),
      pnode_name: row.pnode_name,
      total_lmp_rt: numeric(row.total_lmp_rt),
      system_energy_price_rt: numeric(row.system_energy_price_rt),
      congestion_price_rt: numeric(row.congestion_price_rt),
      marginal_loss_price_rt: numeric(row.marginal_loss_price_rt)
    }))
    .sort(byHour);
  sendJson(res, 200, {
    zone, pnodeId, date, granularity: gran,
    summary: summarizeRtLmp(normalized),
    rows: normalized
  });
}

async function handleRtBindingConstraints(_req, res, url) {
  const date = requireDate(url.searchParams.get("date"));
  const rows = await getPjmRows("rt_marginal_value", {
    datetime_beginning_ept: marketDayRange(date)
  });
  const filtered = rows
    .filter(row => isSelectedDate(row.datetime_beginning_ept, date))
    .map(row => ({
      datetime_beginning_ept: row.datetime_beginning_ept,
      monitored_facility: row.monitored_facility,
      contingency_facility: row.contingency_facility,
      shadow_price: numeric(row.shadow_price)
    }))
    .sort(byHour);
  sendJson(res, 200, { date, summary: summarizeBinding(filtered), rows: filtered });
}

function summarizeRtLmp(rows) {
  const values = rows.map(r => r.total_lmp_rt).filter(Number.isFinite);
  const maxRow = rows.reduce((best, r) => (r.total_lmp_rt ?? -Infinity) > (best?.total_lmp_rt ?? -Infinity) ? r : best, null);
  const minRow = rows.reduce((best, r) => (r.total_lmp_rt ?? Infinity)  < (best?.total_lmp_rt ??  Infinity) ? r : best, null);
  return {
    intervals: rows.length,
    average_lmp: avg(values),
    max_lmp: maxRow?.total_lmp_rt ?? null,
    max_time: maxRow?.datetime_beginning_ept ?? null,
    min_lmp: minRow?.total_lmp_rt ?? null,
    min_time: minRow?.datetime_beginning_ept ?? null,
    average_congestion: avg(rows.map(r => r.congestion_price_rt).filter(Number.isFinite))
  };
}

async function handleTransmissionConstraints(_req, res, url) {
  const date = requireDate(url.searchParams.get("date"));
  const monitored = lowerOrEmpty(url.searchParams.get("monitored"));
  const contingency = lowerOrEmpty(url.searchParams.get("contingency"));
  const rows = await getPjmRows("da_transconstraints", {
    datetime_beginning_ept: marketDayRange(date)
  });

  const filtered = rows.filter((row) => isSelectedDate(row.datetime_beginning_ept, date)).map((row) => ({
    datetime_beginning_ept: row.datetime_beginning_ept,
    datetime_ending_ept: row.datetime_ending_ept,
    duration: numeric(row.duration),
    day_ahead_congestion_event: row.day_ahead_congestion_event,
    monitored_facility: row.monitored_facility,
    contingency_facility: row.contingency_facility
  })).filter((row) => includes(row.monitored_facility, monitored) && includes(row.contingency_facility, contingency));
  filtered.sort(byHour);

  sendJson(res, 200, {
    date,
    summary: summarizeTransmission(filtered),
    rows: filtered
  });
}

async function handleBindingConstraints(_req, res, url) {
  const date = requireDate(url.searchParams.get("date"));
  const minShadowPrice = Number(url.searchParams.get("min_shadow_price") || 0);
  const monitored = lowerOrEmpty(url.searchParams.get("monitored"));
  const contingency = lowerOrEmpty(url.searchParams.get("contingency"));
  const rows = await getPjmRows("da_marginal_value", {
    datetime_beginning_ept: marketDayRange(date)
  });

  const filtered = rows.filter((row) => isSelectedDate(row.datetime_beginning_ept, date)).map((row) => ({
    datetime_beginning_ept: row.datetime_beginning_ept,
    datetime_ending_ept: row.datetime_ending_ept,
    monitored_facility: row.monitored_facility,
    contingency_facility: row.contingency_facility,
    shadow_price: numeric(row.shadow_price)
  })).filter((row) => Math.abs(row.shadow_price || 0) >= minShadowPrice)
    .filter((row) => includes(row.monitored_facility, monitored) && includes(row.contingency_facility, contingency))
    .sort((a, b) => Math.abs(b.shadow_price || 0) - Math.abs(a.shadow_price || 0));

  sendJson(res, 200, {
    date,
    summary: summarizeBinding(filtered),
    rows: filtered
  });
}

async function handleRenewables(_req, res, url) {
  const date = requireDate(url.searchParams.get("date"));
  const area = cleanUpper(url.searchParams.get("area") || "RTO");
  const [solarRows, windRows] = await Promise.all([
    getPjmRows("solar_gen", {
      area,
      datetime_beginning_ept: marketDayRange(date)
    }),
    getPjmRows("wind_gen", {
      area,
      datetime_beginning_ept: marketDayRange(date)
    })
  ]);

  const byHour = new Map();
  for (const row of solarRows.filter((item) => isSelectedDate(item.datetime_beginning_ept, date))) {
    const hour = row.datetime_beginning_ept;
    byHour.set(hour, { datetime_beginning_ept: hour, area, solar_generation_mw: numeric(row.solar_generation_mw), wind_generation_mw: null });
  }
  for (const row of windRows.filter((item) => isSelectedDate(item.datetime_beginning_ept, date))) {
    const hour = row.datetime_beginning_ept;
    const existing = byHour.get(hour) || { datetime_beginning_ept: hour, area, solar_generation_mw: null, wind_generation_mw: null };
    existing.wind_generation_mw = numeric(row.wind_generation_mw);
    byHour.set(hour, existing);
  }
  const rows = [...byHour.values()].sort((a, b) => String(a.datetime_beginning_ept).localeCompare(String(b.datetime_beginning_ept)));
  for (const row of rows) {
    row.total_renewable_mw = (row.solar_generation_mw || 0) + (row.wind_generation_mw || 0);
  }

  sendJson(res, 200, {
    date,
    area,
    summary: summarizeRenewables(rows),
    rows
  });
}

async function handleAnalysis(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Use POST" });
    return;
  }
  if (!process.env.OPENROUTER_API_KEY) {
    sendJson(res, 400, { error: "OPENROUTER_API_KEY is not configured on the server." });
    return;
  }

  const body = await readJsonBody(req);
  const mode = body?.context?.mode ?? "single";
  const payload = shrinkForModel(body);

  const modeGuide = {
    single:  "Analyze this single-zone PJM day-ahead market snapshot.",
    compare: "Analyze this two-zone PJM day-ahead comparison. Explain the basis spread: what drives it (congestion, topology, generation mix), how it evolves by hour, and practical trading or hedging implications. Add a Basis Analysis section.",
    multi:   "Analyze this multi-zone PJM day-ahead snapshot. Rank zones by average LMP, identify the most congested zones, flag any significant divergence or convergence between zones, and note shared price drivers. Add a Zone Rankings section."
  };

  const extraSections = mode === "compare" ? ", Basis Analysis" : mode === "multi" ? ", Zone Rankings" : mode === "custom" ? ", PNode vs Zone Spread" : "";
  const maxTokens    = mode === "multi" ? 2000 : mode === "compare" || mode === "custom" ? 1600 : 1200;

  const prompt = [
    "You are analyzing PJM day-ahead market data for a power-market operator.",
    "Use the supplied JSON only. Be concise, specific, and cite observed values.",
    modeGuide[mode] ?? modeGuide.single,
    `Return markdown with sections: Executive Read, Price Drivers, Constraints, Renewables, Watch Items${extraSections}.`,
    "",
    JSON.stringify(payload, null, 2)
  ].join("\n");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PJM_TIMEOUT_SECONDS * 1000);
  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": process.env.OPENROUTER_SITE_URL || `http://localhost:${PORT}`,
        "X-Title": process.env.OPENROUTER_APP_NAME || "PJM Market Analyst"
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        messages: [
          { role: "system", content: "You are a senior PJM power-market analyst." },
          { role: "user", content: prompt }
        ],
        temperature: 0.2,
        max_tokens: maxTokens
      })
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      sendJson(res, response.status, { error: "OpenRouter request failed", detail: json });
      return;
    }
    sendJson(res, 200, {
      model: OPENROUTER_MODEL,
      analysis: json.choices?.[0]?.message?.content || "",
      rawUsage: json.usage || null
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function getPjmRows(feed, params, options = {}) {
  if (!PJM_API_KEY) {
    throw new Error("PJM_API_KEY is not configured on the server.");
  }
  const cacheKey = JSON.stringify({ feed, params });
  const ttlMs = options.ttlMs ?? 5 * 60 * 1000;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < ttlMs) {
    return cached.rows;
  }

  const allRows = [];
  const pageSize = 50000;
  let startRow = 1;
  for (let page = 0; page < 10; page += 1) {
    await rateLimit();
    const url = new URL(`${PJM_BASE_URL}/${feed}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, value);
      }
    }
    url.searchParams.set("rowCount", String(pageSize));
    url.searchParams.set("startRow", String(startRow));
    if (PJM_AUTH_MODE === "query" || PJM_AUTH_MODE === "both") {
      url.searchParams.set("subscription-key", PJM_API_KEY);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PJM_TIMEOUT_SECONDS * 1000);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: authHeaders()
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(`PJM ${feed} failed (${response.status}): ${JSON.stringify(json).slice(0, 500)}`);
      }
      const rows = extractRows(json);
      allRows.push(...rows);
      if (rows.length < pageSize) break;
      startRow += pageSize;
    } finally {
      clearTimeout(timeout);
    }
  }

  cache.set(cacheKey, { at: Date.now(), rows: allRows });
  return allRows;
}

function authHeaders() {
  const headers = { "Accept": "application/json" };
  if (PJM_AUTH_MODE === "header" || PJM_AUTH_MODE === "both") {
    headers["Ocp-Apim-Subscription-Key"] = PJM_API_KEY;
  }
  return headers;
}

async function rateLimit() {
  const now = Date.now();
  if (now - rateState.windowStart >= 60_000) {
    rateState.windowStart = now;
    rateState.count = 0;
  }
  if (rateState.count >= PJM_RATE_LIMIT_PER_MINUTE) {
    const waitMs = 60_000 - (now - rateState.windowStart);
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, waitMs)));
    rateState.windowStart = Date.now();
    rateState.count = 0;
  }
  rateState.count += 1;
}

function extractRows(json) {
  if (Array.isArray(json)) return json;
  if (Array.isArray(json.items)) return json.items;
  if (Array.isArray(json.data)) return json.data;
  if (Array.isArray(json.results)) return json.results;
  if (Array.isArray(json.rows)) return json.rows;
  return [];
}

function summarizeLmp(rows) {
  const values = rows.map((row) => row.total_lmp_da).filter(Number.isFinite);
  const maxRow = rows.reduce((best, row) => row.total_lmp_da > (best?.total_lmp_da ?? -Infinity) ? row : best, null);
  const minRow = rows.reduce((best, row) => row.total_lmp_da < (best?.total_lmp_da ?? Infinity) ? row : best, null);
  return {
    hours: rows.length,
    average_lmp: avg(values),
    max_lmp: maxRow?.total_lmp_da ?? null,
    max_hour: maxRow?.datetime_beginning_ept ?? null,
    min_lmp: minRow?.total_lmp_da ?? null,
    min_hour: minRow?.datetime_beginning_ept ?? null,
    average_congestion: avg(rows.map((row) => row.congestion_price_da).filter(Number.isFinite)),
    average_loss: avg(rows.map((row) => row.marginal_loss_price_da).filter(Number.isFinite))
  };
}

function summarizeTransmission(rows) {
  return {
    records: rows.length,
    unique_monitored_facilities: new Set(rows.map((row) => row.monitored_facility).filter(Boolean)).size,
    top_monitored: rank(rows, "monitored_facility", 10)
  };
}

function summarizeBinding(rows) {
  const abs = rows.map((row) => Math.abs(row.shadow_price || 0));
  return {
    records: rows.length,
    max_abs_shadow_price: abs.length ? Math.max(...abs) : null,
    top_monitored: rank(rows, "monitored_facility", 10),
    top_constraints: rows.slice(0, 10)
  };
}

function summarizeRenewables(rows) {
  return {
    hours: rows.length,
    average_solar_mw: avg(rows.map((row) => row.solar_generation_mw).filter(Number.isFinite)),
    peak_solar_mw: maxNumber(rows.map((row) => row.solar_generation_mw)),
    average_wind_mw: avg(rows.map((row) => row.wind_generation_mw).filter(Number.isFinite)),
    peak_wind_mw: maxNumber(rows.map((row) => row.wind_generation_mw)),
    average_total_mw: avg(rows.map((row) => row.total_renewable_mw).filter(Number.isFinite))
  };
}

function shrinkForModel(body) {
  const mode = body?.context?.mode ?? "single";

  function lmpRows(rows = []) {
    return rows.map((r) => ({
      hour: r.datetime_beginning_ept,
      lmp: r.total_lmp_da,
      energy: r.system_energy_price_da,
      congestion: r.congestion_price_da,
      loss: r.marginal_loss_price_da
    }));
  }

  const shared = {
    mode,
    date: body?.context?.date,
    area: body?.context?.area,
    bindingSummary: body?.binding?.summary,
    topBinding: (body?.binding?.rows || []).slice(0, 25),
    transmissionSummary: body?.transmission?.summary,
    transmissionSample: (body?.transmission?.rows || []).slice(0, 20),
    renewablesSummary: body?.renewables?.summary,
    renewableHourly: (body?.renewables?.rows || []).map((r) => ({
      hour: r.datetime_beginning_ept,
      solar: r.solar_generation_mw,
      wind: r.wind_generation_mw,
      total: r.total_renewable_mw
    }))
  };

  if (mode === "compare") {
    const rows1 = body?.lmp1?.rows || [];
    const rows2 = body?.lmp2?.rows || [];
    // Build hourly spread alongside the two LMP series
    const spreadHourly = rows1.map((r, i) => ({
      hour: r.datetime_beginning_ept,
      spread: (r.total_lmp_da != null && rows2[i]?.total_lmp_da != null)
        ? Math.round((r.total_lmp_da - rows2[i].total_lmp_da) * 100) / 100
        : null
    }));
    return {
      ...shared,
      zone1: body?.context?.zone1,
      zone2: body?.context?.zone2,
      lmp1Summary: body?.lmp1?.summary,
      lmp1Hourly: lmpRows(rows1),
      lmp2Summary: body?.lmp2?.summary,
      lmp2Hourly: lmpRows(rows2),
      spreadHourly
    };
  }

  if (mode === "multi") {
    return {
      ...shared,
      zones: body?.context?.zones,
      // One entry per active zone — summary + full 24-h hourly
      zoneData: (body?.lmpZones || []).map((z) => ({
        zone: z.zone,
        summary: z.summary,
        hourly: lmpRows(z.rows || [])
      }))
    };
  }

  if (mode === "custom") {
    return {
      ...shared,
      pnodeId: body?.context?.pnodeId,
      pnodeName: body?.context?.pnodeName,
      compareZones: body?.context?.compareZones,
      lmpSummary: body?.lmp?.summary,
      lmpHourly: lmpRows(body?.lmp?.rows || []),
      lmpCompare: (body?.lmpCompare || []).map((z) => ({
        zone: z?.zone, summary: z?.summary, hourly: lmpRows(z?.rows || [])
      }))
    };
  }

  // single (default)
  return {
    ...shared,
    zone: body?.context?.zone,
    lmpSummary: body?.lmp?.summary,
    lmpHourly: lmpRows(body?.lmp?.rows || [])
  };
}

function rank(rows, field, limit) {
  const counts = new Map();
  for (const row of rows) {
    const key = row[field] || "Unknown";
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, count]) => ({ name, count }));
}

function byHour(a, b) {
  return String(a.datetime_beginning_ept || "").localeCompare(String(b.datetime_beginning_ept || ""));
}

function isSelectedDate(value, date) {
  return String(value || "").slice(0, 10) === date;
}

function avg(values) {
  if (!values.length) return null;
  return round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function maxNumber(values) {
  const finite = values.filter(Number.isFinite);
  return finite.length ? round(Math.max(...finite)) : null;
}

function round(value) {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}

function numeric(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function marketDayRange(date) {
  const next = new Date(`${date}T00:00:00`);
  next.setDate(next.getDate() + 1);
  const end = [
    next.getFullYear(),
    String(next.getMonth() + 1).padStart(2, "0"),
    String(next.getDate()).padStart(2, "0")
  ].join("-");
  return `${date} 00:00 to ${end} 00:00`;
}

function requireDate(value) {
  const date = value || new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error("Date must use YYYY-MM-DD format.");
  }
  return date;
}

function cleanUpper(value) {
  return String(value || "").trim().toUpperCase();
}

function lowerOrEmpty(value) {
  return String(value || "").trim().toLowerCase();
}

function includes(value, needle) {
  return !needle || String(value || "").toLowerCase().includes(needle);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

async function serveStatic(res, pathname) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const requested = path.normalize(path.join(publicDir, safePath));
  if (!requested.startsWith(publicDir)) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }
  try {
    const data = await readFile(requested);
    res.writeHead(200, {
      "Content-Type": contentType(requested),
      "Cache-Control": "no-store"
    });
    res.end(data);
  } catch {
    const fallback = await readFile(path.join(publicDir, "index.html"));
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(fallback);
  }
}

function contentType(filePath) {
  const ext = path.extname(filePath);
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".js") return "application/javascript; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml";
  return "application/octet-stream";
}

function loadDotEnv(filePath) {
  try {
    const text = readFileSync(filePath, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
      const index = trimmed.indexOf("=");
      const key = trimmed.slice(0, index).trim();
      const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch {
    // A .env file is optional; production deployments should use real environment variables.
  }
}
