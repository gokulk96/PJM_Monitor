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
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "deepseek/deepseek-v4-flash";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";

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
  "/api/pjm/da-lmp/zone/monthly": handleZoneLmpMonthly,
  "/api/pjm/rt-lmp/zone": handleZoneRtLmp,
  "/api/pjm/rt-lmp/zone/monthly": handleZoneRtLmpMonthly,
  "/api/pjm/dart/monthly": handleDartMonthly,
  "/api/pjm/constraints/transmission": handleTransmissionConstraints,
  "/api/pjm/constraints/binding": handleBindingConstraints,
  "/api/pjm/constraints/binding/monthly": handleBindingConstraintsMonthly,
  "/api/pjm/constraints/rt-binding": handleRtBindingConstraints,
  "/api/pjm/renewables": handleRenewables,
  "/api/pjm/renewables/monthly": handleRenewablesMonthly,
  "/api/pjm/emissions": handleEmissions,
  "/api/pjm/emissions/monthly": handleEmissionsMonthly,
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
    geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
    geminiModel: GEMINI_MODEL,
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

  console.log(`da_hrl_lmps raw=${rows.length} zone=${zone} date=${date} sample_ept=${rows[0]?.datetime_beginning_ept ?? 'none'}`);

  const normalized = rows.map((row) => ({
    datetime_beginning_ept: normalizeEpt(row.datetime_beginning_ept),
    datetime_beginning_utc: row.datetime_beginning_utc,
    pnode_id: numeric(row.pnode_id),
    pnode_name: row.pnode_name,
    zone: row.zone || zone,
    total_lmp_da: numeric(row.total_lmp_da),
    system_energy_price_da: numeric(row.system_energy_price_da),
    congestion_price_da: numeric(row.congestion_price_da),
    marginal_loss_price_da: numeric(row.marginal_loss_price_da)
  })).filter((row) => isSelectedDate(row.datetime_beginning_ept, date)).sort(byHour);

  console.log(`da_hrl_lmps filtered=${normalized.length} date=${date}`);

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

  console.log(`${feed} raw=${rows.length} zone=${zone} date=${date} sample_ept=${rows[0]?.datetime_beginning_ept ?? 'none'}`);

  const normalized = rows
    .map(row => ({
      datetime_beginning_ept: normalizeEpt(row.datetime_beginning_ept),
      pnode_id: numeric(row.pnode_id),
      pnode_name: row.pnode_name,
      total_lmp_rt: numeric(row.total_lmp_rt),
      system_energy_price_rt: numeric(row.system_energy_price_rt),
      congestion_price_rt: numeric(row.congestion_price_rt),
      marginal_loss_price_rt: numeric(row.marginal_loss_price_rt)
    }))
    .filter(row => isSelectedDate(row.datetime_beginning_ept, date))
    .sort(byHour);

  console.log(`${feed} filtered=${normalized.length} date=${date}`);
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
    .map(row => ({
      datetime_beginning_ept: normalizeEpt(row.datetime_beginning_ept),
      monitored_facility: row.monitored_facility,
      contingency_facility: row.contingency_facility,
      shadow_price: numeric(row.shadow_price)
    }))
    .filter(row => isSelectedDate(row.datetime_beginning_ept, date))
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

  const filtered = rows.map((row) => ({
    datetime_beginning_ept: normalizeEpt(row.datetime_beginning_ept),
    datetime_ending_ept:    normalizeEpt(row.datetime_ending_ept),
    monitored_facility: row.monitored_facility,
    contingency_facility: row.contingency_facility,
    shadow_price: numeric(row.shadow_price)
  })).filter((row) => isSelectedDate(row.datetime_beginning_ept, date))
    .filter((row) => Math.abs(row.shadow_price || 0) >= minShadowPrice)
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

async function handleEmissions(_req, res, url) {
  const zone = cleanUpper(url.searchParams.get("zone") || "");
  const date = requireDate(url.searchParams.get("date"));
  const pnodeId = await resolveEmissionsPnode(zone, url.searchParams.get("pnode_id"));

  const params = { datetime_beginning_ept: marketDayRange(date) };
  if (pnodeId) params.pnode_id = pnodeId;

  const rows = await getPjmRows("fivemin_marginal_emissions", params);

  const normalized = rows
    .map(row => ({
      datetime_beginning_ept: normalizeEpt(row.datetime_beginning_ept),
      pnode_id: numeric(row.pnode_id),
      pnode_name: row.pnode_name,
      marginal_co2_rate: numeric(row.marginal_co2_rate),
      marginal_so2_rate: numeric(row.marginal_so2_rate),
      marginal_nox_rate: numeric(row.marginal_nox_rate)
    }))
    .filter(row => isSelectedDate(row.datetime_beginning_ept, date));

  // Aggregate 5-min intervals → hourly averages
  const hourlyMap = new Map();
  for (const row of normalized) {
    const h = parseInt(String(row.datetime_beginning_ept).slice(11, 13), 10);
    if (!Number.isFinite(h)) continue;
    if (!hourlyMap.has(h)) hourlyMap.set(h, { co2: [], so2: [], nox: [] });
    const bucket = hourlyMap.get(h);
    if (row.marginal_co2_rate != null) bucket.co2.push(row.marginal_co2_rate);
    if (row.marginal_so2_rate != null) bucket.so2.push(row.marginal_so2_rate);
    if (row.marginal_nox_rate != null) bucket.nox.push(row.marginal_nox_rate);
  }

  const hourly = Array.from({ length: 24 }, (_, h) => {
    const b = hourlyMap.get(h) || { co2: [], so2: [], nox: [] };
    return {
      hour: h,
      marginal_co2_rate: avg(b.co2),
      marginal_so2_rate: avg(b.so2),
      marginal_nox_rate: avg(b.nox)
    };
  });

  const allCo2 = hourly.map(r => r.marginal_co2_rate).filter(Number.isFinite);
  const allSo2 = hourly.map(r => r.marginal_so2_rate).filter(Number.isFinite);
  const allNox = hourly.map(r => r.marginal_nox_rate).filter(Number.isFinite);

  sendJson(res, 200, {
    zone: zone || null, date,
    summary: {
      avg_co2: avg(allCo2), peak_co2: allCo2.length ? round(Math.max(...allCo2)) : null,
      avg_so2: avg(allSo2), peak_so2: allSo2.length ? round(Math.max(...allSo2)) : null,
      avg_nox: avg(allNox), peak_nox: allNox.length ? round(Math.max(...allNox)) : null
    },
    rows: hourly
  });
}

async function handleEmissionsMonthly(_req, res, url) {
  const zone = cleanUpper(url.searchParams.get("zone") || "");
  const month = requireYearMonth(url.searchParams.get("month"));
  const pnodeId = await resolveEmissionsPnode(zone, url.searchParams.get("pnode_id"));

  const params = { datetime_beginning_ept: marketMonthRange(month) };
  if (pnodeId) params.pnode_id = pnodeId;

  const rows = await getPjmRows("fivemin_marginal_emissions", params, { ttlMs: monthCacheTtl(month) });

  const normalized = rows
    .map(row => ({
      datetime_beginning_ept: normalizeEpt(row.datetime_beginning_ept),
      marginal_co2_rate: numeric(row.marginal_co2_rate),
      marginal_so2_rate: numeric(row.marginal_so2_rate),
      marginal_nox_rate: numeric(row.marginal_nox_rate)
    }))
    .filter(row => String(row.datetime_beginning_ept).slice(0, 7) === month);

  const byDay = groupByDay(normalized);
  const days = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, dayRows]) => ({
    date,
    avg_co2: avg(dayRows.map(r => r.marginal_co2_rate).filter(Number.isFinite)),
    avg_so2: avg(dayRows.map(r => r.marginal_so2_rate).filter(Number.isFinite)),
    avg_nox: avg(dayRows.map(r => r.marginal_nox_rate).filter(Number.isFinite))
  }));

  const allCo2 = days.map(d => d.avg_co2).filter(Number.isFinite);
  sendJson(res, 200, {
    zone: zone || null, month, days,
    monthSummary: {
      avg_co2: avg(allCo2),
      peak_co2_day: days.reduce((b, d) => (d.avg_co2 ?? -Infinity) > (b?.avg_co2 ?? -Infinity) ? d : b, null)?.date ?? null
    }
  });
}

async function resolveEmissionsPnode(zone, rawPnodeId) {
  if (rawPnodeId) return String(rawPnodeId);
  if (!zone) return null;
  if (/^\d+$/.test(zone)) return zone;

  // Known zone → direct lookup from ZONE_PNODES map
  if (zone in ZONE_PNODES) return String(ZONE_PNODES[zone]);

  // Try resolving via PJM pnode endpoint (zone filter first, then pnode_name)
  try {
    const isZoneCode = Object.keys(ZONE_PNODES).includes(zone);
    const filterParam = isZoneCode ? { zone } : { pnode_name: zone };
    const pnodeRows = await getPjmRows("pnode", filterParam, { ttlMs: 60 * 60 * 1000 });
    if (pnodeRows.length > 0) {
      return pnodeRows.map(r => r.pnode_id).filter(Boolean).join(";") || null;
    }
  } catch {
    // If pnode lookup fails, proceed without location filter
  }
  return null;
}

async function handleZoneLmpMonthly(_req, res, url) {
  const zone = cleanUpper(url.searchParams.get("zone") || "PSEG");
  const month = requireYearMonth(url.searchParams.get("month"));
  const pnodeId = Number(url.searchParams.get("pnode_id") || ZONE_PNODES[zone]);
  if (!pnodeId) { sendJson(res, 400, { error: `Unknown zone '${zone}'.` }); return; }

  const rows = await getPjmRows("da_hrl_lmps", {
    row_is_current: "true",
    pnode_id: String(pnodeId),
    datetime_beginning_ept: marketMonthRange(month)
  }, { ttlMs: monthCacheTtl(month) });

  const normalized = rows.map(row => ({
    datetime_beginning_ept: normalizeEpt(row.datetime_beginning_ept),
    total_lmp_da: numeric(row.total_lmp_da),
    congestion_price_da: numeric(row.congestion_price_da),
    marginal_loss_price_da: numeric(row.marginal_loss_price_da)
  })).filter(row => String(row.datetime_beginning_ept).slice(0, 7) === month);

  const days = aggregateDailyLmp(normalized);
  const allAvgs = days.map(d => d.avg_lmp_da).filter(Number.isFinite);
  const peakDay = days.reduce((best, d) => (d.max_lmp_da ?? -Infinity) > (best?.max_lmp_da ?? -Infinity) ? d : best, null);
  sendJson(res, 200, { zone, month, days, monthSummary: { avg_lmp: avg(allAvgs), peak_day: peakDay?.date ?? null, peak_lmp: peakDay?.max_lmp_da ?? null } });
}

async function handleZoneRtLmpMonthly(_req, res, url) {
  const zone = cleanUpper(url.searchParams.get("zone") || "PSEG");
  const month = requireYearMonth(url.searchParams.get("month"));
  const pnodeId = Number(url.searchParams.get("pnode_id") || ZONE_PNODES[zone]);
  if (!pnodeId) { sendJson(res, 400, { error: `Unknown zone '${zone}'.` }); return; }

  const rows = await getPjmRows("rt_hrl_lmps", {
    row_is_current: "true",
    pnode_id: String(pnodeId),
    datetime_beginning_ept: marketMonthRange(month)
  }, { ttlMs: monthCacheTtl(month) });

  const normalized = rows.map(row => ({
    datetime_beginning_ept: normalizeEpt(row.datetime_beginning_ept),
    total_lmp_rt: numeric(row.total_lmp_rt),
    congestion_price_rt: numeric(row.congestion_price_rt)
  })).filter(row => String(row.datetime_beginning_ept).slice(0, 7) === month);

  const days = aggregateDailyRt(normalized);
  const allAvgs = days.map(d => d.avg_lmp_rt).filter(Number.isFinite);
  const peakDay = days.reduce((best, d) => (d.max_lmp_rt ?? -Infinity) > (best?.max_lmp_rt ?? -Infinity) ? d : best, null);
  sendJson(res, 200, { zone, month, days, monthSummary: { avg_lmp_rt: avg(allAvgs), peak_day: peakDay?.date ?? null, peak_lmp_rt: peakDay?.max_lmp_rt ?? null } });
}

async function handleDartMonthly(_req, res, url) {
  const zone = cleanUpper(url.searchParams.get("zone") || "PSEG");
  const month = requireYearMonth(url.searchParams.get("month"));
  const pnodeId = Number(url.searchParams.get("pnode_id") || ZONE_PNODES[zone]);
  if (!pnodeId) { sendJson(res, 400, { error: `Unknown zone '${zone}'.` }); return; }

  const ttlMs = monthCacheTtl(month);
  const [daRows, rtRows] = await Promise.all([
    getPjmRows("da_hrl_lmps", { row_is_current: "true", pnode_id: String(pnodeId), datetime_beginning_ept: marketMonthRange(month) }, { ttlMs }),
    getPjmRows("rt_hrl_lmps", { row_is_current: "true", pnode_id: String(pnodeId), datetime_beginning_ept: marketMonthRange(month) }, { ttlMs })
  ]);

  const normDa = daRows.map(r => ({
    datetime_beginning_ept: normalizeEpt(r.datetime_beginning_ept),
    total_lmp_da: numeric(r.total_lmp_da),
    congestion_price_da: numeric(r.congestion_price_da)
  })).filter(r => String(r.datetime_beginning_ept).slice(0, 7) === month);

  const normRt = rtRows.map(r => ({
    datetime_beginning_ept: normalizeEpt(r.datetime_beginning_ept),
    total_lmp_rt: numeric(r.total_lmp_rt),
    congestion_price_rt: numeric(r.congestion_price_rt)
  })).filter(r => String(r.datetime_beginning_ept).slice(0, 7) === month);

  const days = aggregateDailyDart(normDa, normRt);
  const darts = days.map(d => d.avg_dart).filter(v => v != null);
  const worstRt = days.reduce((best, d) => (d.max_rt_premium ?? -Infinity) > (best?.max_rt_premium ?? -Infinity) ? d : best, null);
  const worstDa = days.reduce((best, d) => (d.max_da_overshoot ?? Infinity) < (best?.max_da_overshoot ?? Infinity) ? d : best, null);
  sendJson(res, 200, {
    zone, month, days,
    monthSummary: {
      avg_dart: avg(darts),
      worst_rt_premium_day: worstRt?.date ?? null, worst_rt_premium: worstRt?.max_rt_premium ?? null,
      worst_da_overshoot_day: worstDa?.date ?? null, worst_da_overshoot: worstDa?.max_da_overshoot ?? null
    }
  });
}

async function handleRenewablesMonthly(_req, res, url) {
  const area = cleanUpper(url.searchParams.get("area") || "RTO");
  const month = requireYearMonth(url.searchParams.get("month"));
  const ttlMs = monthCacheTtl(month);
  const [solarRows, windRows] = await Promise.all([
    getPjmRows("solar_gen", { area, datetime_beginning_ept: marketMonthRange(month) }, { ttlMs }),
    getPjmRows("wind_gen",  { area, datetime_beginning_ept: marketMonthRange(month) }, { ttlMs })
  ]);

  const normSolar = solarRows.map(r => ({ ...r, datetime_beginning_ept: normalizeEpt(r.datetime_beginning_ept) }))
    .filter(r => String(r.datetime_beginning_ept).slice(0, 7) === month);
  const normWind = windRows.map(r => ({ ...r, datetime_beginning_ept: normalizeEpt(r.datetime_beginning_ept) }))
    .filter(r => String(r.datetime_beginning_ept).slice(0, 7) === month);

  const days = aggregateDailyRenewables(normSolar, normWind);
  const allSolar = days.map(d => d.avg_solar_mw).filter(Number.isFinite);
  const allWind  = days.map(d => d.avg_wind_mw).filter(Number.isFinite);
  const peakSolarDay = days.reduce((best, d) => (d.peak_solar_mw ?? -Infinity) > (best?.peak_solar_mw ?? -Infinity) ? d : best, null);
  const peakWindDay  = days.reduce((best, d) => (d.peak_wind_mw  ?? -Infinity) > (best?.peak_wind_mw  ?? -Infinity) ? d : best, null);
  sendJson(res, 200, {
    area, month, days,
    monthSummary: {
      avg_solar_mw: avg(allSolar), avg_wind_mw: avg(allWind),
      peak_solar_day: peakSolarDay?.date ?? null, peak_solar_mw: peakSolarDay?.peak_solar_mw ?? null,
      peak_wind_day: peakWindDay?.date ?? null, peak_wind_mw: peakWindDay?.peak_wind_mw ?? null
    }
  });
}

async function handleBindingConstraintsMonthly(_req, res, url) {
  const month = requireYearMonth(url.searchParams.get("month"));
  const rows = await getPjmRows("da_marginal_value", {
    datetime_beginning_ept: marketMonthRange(month)
  }, { ttlMs: monthCacheTtl(month) });

  const filtered = rows.map(row => ({
    datetime_beginning_ept: normalizeEpt(row.datetime_beginning_ept),
    monitored_facility: row.monitored_facility,
    contingency_facility: row.contingency_facility,
    shadow_price: numeric(row.shadow_price)
  })).filter(row => String(row.datetime_beginning_ept).slice(0, 7) === month);

  const facilities = aggregateMonthlyConstraints(filtered);
  const uniqueCount = new Set(filtered.map(r => `${r.monitored_facility}||${r.contingency_facility || ""}`)).size;
  sendJson(res, 200, { month, total_unique_constraints: uniqueCount, facilities });
}

async function handleAnalysis(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Use POST" });
    return;
  }

  const useGemini = Boolean(process.env.GEMINI_API_KEY);
  const useOpenRouter = Boolean(process.env.OPENROUTER_API_KEY);
  if (!useGemini && !useOpenRouter) {
    sendJson(res, 400, { error: "No AI API key configured. Set GEMINI_API_KEY or OPENROUTER_API_KEY." });
    return;
  }

  const body = await readJsonBody(req);
  const mode = body?.context?.mode ?? "single";
  const payload = shrinkForModel(body);

  const modeGuide = {
    single:  "Analyze this single-zone PJM day-ahead market snapshot.",
    compare: "Analyze this two-zone PJM day-ahead comparison. Explain the basis spread: what drives it (congestion, topology, generation mix), how it evolves by hour, and practical trading or hedging implications. Add a Basis Analysis section.",
    multi:   "Analyze this multi-zone PJM day-ahead snapshot. Rank zones by average LMP, identify the most congested zones, flag any significant divergence or convergence between zones, and note shared price drivers. Add a Zone Rankings section.",
    rt:      "Analyze this PJM real-time LMP feed. Identify price volatility patterns, congestion events, and notable spikes. Distinguish system-energy vs congestion contributions to price moves. Flag any intervals where congestion dominated. Add Volatility Events and Congestion Drivers sections.",
    dart:    "Analyze this PJM DA vs RT (DART) spread. Explain what drove RT above or below DA commitments each hour — surprise congestion, system energy deviations, or unforecasted load. Quantify the largest divergences and note practical trading/hedging implications. Add DART Drivers and Trading Implications sections."
  };

  const extraSections = {
    compare: ", Basis Analysis",
    multi:   ", Zone Rankings",
    custom:  ", PNode vs Zone Spread",
    rt:      ", Volatility Events, Congestion Drivers",
    dart:    ", DART Drivers, Trading Implications"
  }[mode] ?? "";

  const maxTokens = { multi: 2000, compare: 1600, custom: 1600, rt: 1400, dart: 1600 }[mode] ?? 1200;

  const isRt   = mode === "rt";
  const isDart = mode === "dart";
  const systemPrompt = isRt   ? "You are analyzing PJM real-time market data for a power-market operator."
                     : isDart ? "You are analyzing PJM day-ahead vs real-time spread data for a power-market operator."
                     :          "You are analyzing PJM day-ahead market data for a power-market operator.";

  const sections = isRt   ? "Executive Read, Price Drivers, Volatility Events, Congestion Drivers, Watch Items"
                 : isDart ? "Executive Read, DART Drivers, Hour Analysis, Trading Implications, Watch Items"
                 :          `Executive Read, Price Drivers, Constraints, Renewables, Watch Items${extraSections}`;

  const userPrompt = [
    "You are a senior PJM power-market analyst.",
    systemPrompt,
    "Use the supplied JSON only. Be concise, specific, and cite observed values.",
    modeGuide[mode] ?? modeGuide.single,
    `Return markdown with sections: ${sections}.`,
    "",
    JSON.stringify(payload, null, 2)
  ].join("\n");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PJM_TIMEOUT_SECONDS * 1000);

  try {
    if (useGemini) {
      const model = GEMINI_MODEL;
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;
      const response = await fetch(url, {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: userPrompt }] }],
          generationConfig: { temperature: 0.2, maxOutputTokens: maxTokens }
        })
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok) {
        const msg = json?.error?.message || json?.error?.status || `HTTP ${response.status}`;
        console.error(`Gemini error ${response.status}:`, JSON.stringify(json).slice(0, 400));
        sendJson(res, response.status, { error: `Gemini: ${msg}`, detail: json });
        return;
      }
      const text = json.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
      sendJson(res, 200, {
        model,
        analysis: text,
        rawUsage: json.usageMetadata || null
      });
    } else {
      // Fallback: OpenRouter
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
            { role: "user", content: userPrompt }
          ],
          temperature: 0.2,
          max_tokens: maxTokens
        })
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok) {
        const msg = json?.error?.message || json?.message || String(json?.error ?? `HTTP ${response.status}`);
        console.error(`OpenRouter error ${response.status}:`, JSON.stringify(json).slice(0, 400));
        sendJson(res, response.status, { error: `OpenRouter: ${msg}`, detail: json });
        return;
      }
      sendJson(res, 200, {
        model: OPENROUTER_MODEL,
        analysis: json.choices?.[0]?.message?.content || "",
        rawUsage: json.usage || null
      });
    }
  } catch (err) {
    const provider = useGemini ? "Gemini" : "OpenRouter";
    const msg = err.name === "AbortError" ? `${provider}: timed out after ${PJM_TIMEOUT_SECONDS}s` : `${provider}: ${err.message}`;
    console.error("Analysis error:", err.message);
    sendJson(res, 502, { error: msg });
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

function aggregateDailyLmp(rows) {
  const byDay = groupByDay(rows);
  return [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, dayRows]) => {
    const lmps  = dayRows.map(r => r.total_lmp_da).filter(Number.isFinite);
    const congs = dayRows.map(r => r.congestion_price_da).filter(Number.isFinite);
    const maxRow = dayRows.reduce((b, r) => (r.total_lmp_da ?? -Infinity) > (b?.total_lmp_da ?? -Infinity) ? r : b, null);
    const minRow = dayRows.reduce((b, r) => (r.total_lmp_da ??  Infinity) < (b?.total_lmp_da ??  Infinity) ? r : b, null);
    return { date, avg_lmp_da: avg(lmps), max_lmp_da: maxRow?.total_lmp_da ?? null, min_lmp_da: minRow?.total_lmp_da ?? null, avg_congestion_da: avg(congs) };
  });
}

function aggregateDailyRt(rows) {
  const byDay = groupByDay(rows);
  return [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, dayRows]) => {
    const lmps  = dayRows.map(r => r.total_lmp_rt).filter(Number.isFinite);
    const congs = dayRows.map(r => r.congestion_price_rt).filter(Number.isFinite);
    const maxRow = dayRows.reduce((b, r) => (r.total_lmp_rt ?? -Infinity) > (b?.total_lmp_rt ?? -Infinity) ? r : b, null);
    return { date, avg_lmp_rt: avg(lmps), max_lmp_rt: maxRow?.total_lmp_rt ?? null, avg_congestion_rt: avg(congs) };
  });
}

function aggregateDailyDart(daRows, rtRows) {
  const rtByHour = new Map();
  for (const row of rtRows) rtByHour.set(String(row.datetime_beginning_ept || "").slice(0, 13), row);

  const byDay = new Map();
  for (const da of daRows) {
    const key = String(da.datetime_beginning_ept || "").slice(0, 13);
    const day = key.slice(0, 10);
    if (!day) continue;
    const rt = rtByHour.get(key);
    const dart = (da.total_lmp_da != null && rt?.total_lmp_rt != null) ? round(rt.total_lmp_rt - da.total_lmp_da) : null;
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push({ da: da.total_lmp_da, rt: rt?.total_lmp_rt ?? null, dart });
  }
  return [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, pairs]) => {
    const darts = pairs.map(p => p.dart).filter(v => v != null);
    const das   = pairs.map(p => p.da).filter(Number.isFinite);
    const rts   = pairs.map(p => p.rt).filter(Number.isFinite);
    return {
      date,
      avg_dart: avg(darts),
      avg_da: avg(das),
      avg_rt: avg(rts),
      hours_rt_above: darts.filter(v => v > 0).length,
      max_rt_premium:   darts.length ? round(Math.max(...darts)) : null,
      max_da_overshoot: darts.length ? round(Math.min(...darts)) : null
    };
  });
}

function aggregateDailyRenewables(solarRows, windRows) {
  const byDay = new Map();
  for (const row of solarRows) {
    const day = String(row.datetime_beginning_ept || "").slice(0, 10);
    if (!day) continue;
    if (!byDay.has(day)) byDay.set(day, { solar: [], wind: [] });
    byDay.get(day).solar.push(numeric(row.solar_generation_mw));
  }
  for (const row of windRows) {
    const day = String(row.datetime_beginning_ept || "").slice(0, 10);
    if (!day) continue;
    if (!byDay.has(day)) byDay.set(day, { solar: [], wind: [] });
    byDay.get(day).wind.push(numeric(row.wind_generation_mw));
  }
  return [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, { solar, wind }]) => {
    const sF = solar.filter(Number.isFinite);
    const wF = wind.filter(Number.isFinite);
    return {
      date,
      avg_solar_mw: avg(sF), peak_solar_mw: sF.length ? round(Math.max(...sF)) : null,
      avg_wind_mw:  avg(wF), peak_wind_mw:  wF.length ? round(Math.max(...wF)) : null
    };
  });
}

function aggregateMonthlyConstraints(rows) {
  const facilityMap = new Map();
  for (const row of rows) {
    const key = `${row.monitored_facility}||${row.contingency_facility || ""}`;
    if (!facilityMap.has(key)) {
      facilityMap.set(key, { monitored_facility: row.monitored_facility, contingency_facility: row.contingency_facility || null, hours_active: 0, peak_shadow_price: 0 });
    }
    const entry = facilityMap.get(key);
    entry.hours_active += 1;
    const sp = Math.abs(row.shadow_price || 0);
    if (sp > entry.peak_shadow_price) entry.peak_shadow_price = sp;
  }
  return [...facilityMap.values()].sort((a, b) => b.hours_active - a.hours_active).slice(0, 15);
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

  if (mode === "rt") {
    return {
      mode,
      zone: body?.context?.zone,
      date: body?.context?.date,
      granularity: body?.context?.granularity,
      lmpSummary: body?.lmpRt?.summary,
      lmpHourly: (body?.lmpRt?.rows || []).map(r => ({
        time: r.datetime_beginning_ept,
        lmp: r.total_lmp_rt,
        energy: r.system_energy_price_rt,
        congestion: r.congestion_price_rt,
        loss: r.marginal_loss_price_rt
      })),
      rtBindingSummary: body?.rtBinding?.summary,
      topRtBinding: (body?.rtBinding?.rows || []).slice(0, 25)
    };
  }

  if (mode === "dart") {
    return {
      mode,
      zone: body?.context?.zone,
      date: body?.context?.date,
      daSummary: body?.lmpDa?.summary,
      rtSummary: body?.lmpRt?.summary,
      dartHourly: (body?.dartHourly || []).map(r => ({
        he: r.he,
        da: r.da,
        rt: r.rt,
        dart: r.dart,
        daCong: r.daCong,
        rtCong: r.rtCong
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

function normalizeEpt(value) {
  const s = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s;                    // already ISO
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s*(.*)$/);   // M/D/YYYY ...
  if (m) return `${m[3]}-${m[1].padStart(2,"0")}-${m[2].padStart(2,"0")}${m[4] ? " " + m[4].trim() : ""}`;
  return s;
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

function marketMonthRange(yearMonth) {
  const [y, m] = yearMonth.split("-").map(Number);
  const end = new Date(y, m, 1);
  const endStr = `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, "0")}-01`;
  return `${yearMonth}-01 00:00 to ${endStr} 00:00`;
}

function requireYearMonth(value) {
  const ym = value || new Date().toISOString().slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(ym)) throw new Error("Month must use YYYY-MM format.");
  return ym;
}

function monthCacheTtl(yearMonth) {
  const cur = new Date().toISOString().slice(0, 7);
  return yearMonth < cur ? 24 * 60 * 60 * 1000 : 5 * 60 * 1000;
}

function groupByDay(rows, field = "datetime_beginning_ept") {
  const map = new Map();
  for (const row of rows) {
    const day = String(row[field] || "").slice(0, 10);
    if (!day) continue;
    if (!map.has(day)) map.set(day, []);
    map.get(day).push(row);
  }
  return map;
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
