# PJM DataMiner 2 API — Handover Reference

## Overview

All market data is sourced from the **PJM DataMiner 2 REST API**.

- **Base URL:** `https://api.pjm.com/api/v1`  
- **API portal / feed catalogue:** https://dataminer2.pjm.com/list  
- **Auth:** Subscription key issued per account. Sent as HTTP header `Ocp-Apim-Subscription-Key` (preferred) or query param `subscription-key`.

> Set `PJM_AUTH_MODE=header` (default). Using `query` or `both` will expose the key in server logs and URLs.

---

## Authentication

```
Header:  Ocp-Apim-Subscription-Key: <your-key>
Query:   ?subscription-key=<your-key>   (avoid — key visible in logs)
```

The dashboard reads the key from `PJM_API_KEY` env var and sends it via header by default.

---

## Generic Request Pattern

Every feed follows the same URL shape:

```
GET https://api.pjm.com/api/v1/{feed_name}
    ?datetime_beginning_ept=<range>
    &<filter_param>=<value>
    &rowCount=50000
    &startRow=1
    &Ocp-Apim-Subscription-Key=...   (or via header)
```

### Pagination

- `rowCount` — max rows per page (use `50000`, the practical ceiling)
- `startRow` — 1-based offset; increment by `rowCount` for subsequent pages
- Stop paginating when a page returns fewer rows than `rowCount`
- The server paginates up to 10 pages (500k rows max); normal daily data never exceeds one page

### Date range filter format

```
datetime_beginning_ept=YYYY-MM-DD 00:00 to YYYY-MM-DD 00:00
```

Examples:
```
# Single day  (midnight-to-midnight, next calendar day)
2026-05-15 00:00 to 2026-05-16 00:00

# Full month
2026-04-01 00:00 to 2026-05-01 00:00
```

EPT = Eastern Prevailing Time (ET — EST or EDT depending on season). The PJM market day runs 00:00–23:00 EPT (24 hourly intervals).

### Response envelope

The API wraps rows in one of several keys depending on the feed. The server tries them in order:

```
json           → raw array
json.items     → most feeds
json.data
json.results
json.rows
```

---

## Rate Limiting

PJM imposes a per-minute call cap (varies by subscription tier). The server enforces a configurable soft cap:

| Env var | Default | Description |
|---|---|---|
| `PJM_RATE_LIMIT_PER_MINUTE` | `6` | Max calls per 60-second window |
| `PJM_TIMEOUT_SECONDS` | `30` | Per-request abort timeout |

If the cap is hit, the server waits until the window resets before making the next call.

---

## Feed Reference

### 1. `da_hrl_lmps` — Day-Ahead Hourly LMPs

| Property | Value |
|---|---|
| Granularity | 1 hour |
| Availability | Published ~11:00 ET day-ahead |
| Filter params | `pnode_id`, `datetime_beginning_ept` |
| Extra filter | `row_is_current=true` (deduplicate revised rows) |

**Key response fields:**

| Field | Type | Description |
|---|---|---|
| `datetime_beginning_ept` | string | Interval start, e.g. `"2026-05-15 00:00"` |
| `pnode_id` | number | Pricing node ID |
| `pnode_name` | string | Human-readable node name |
| `zone` | string | Zone abbreviation |
| `total_lmp_da` | number | Total DA LMP ($/MWh) |
| `system_energy_price_da` | number | System energy component ($/MWh) |
| `congestion_price_da` | number | Congestion component ($/MWh) |
| `marginal_loss_price_da` | number | Loss component ($/MWh) |

**Used for:** DA LMP chart (hourly), DA monthly aggregation, DART spread (DA side).

---

### 2. `rt_hrl_lmps` — Real-Time Hourly LMPs

| Property | Value |
|---|---|
| Granularity | 1 hour |
| Availability | ~1 hour lag (settlements run hourly) |
| Filter params | `pnode_id`, `datetime_beginning_ept` |
| Extra filter | `row_is_current=true` |

**Key response fields:**

| Field | Type | Description |
|---|---|---|
| `datetime_beginning_ept` | string | Interval start |
| `pnode_id` | number | |
| `pnode_name` | string | |
| `total_lmp_rt` | number | Total RT LMP ($/MWh) |
| `system_energy_price_rt` | number | |
| `congestion_price_rt` | number | |
| `marginal_loss_price_rt` | number | |

**Used for:** RT LMP chart, DART spread (RT side), RT monthly aggregation.

---

### 3. `rt_fivemin_hrl_lmps` — Real-Time 5-Minute LMPs

| Property | Value |
|---|---|
| Granularity | 5 minutes (12 intervals/hour, 288/day) |
| Availability | ~15-minute lag |
| Filter params | `pnode_id`, `datetime_beginning_ept` |
| Extra filter | `row_is_current=true` |

Same fields as `rt_hrl_lmps` but with `_rt` suffix. Up to 288 rows per zone per day. Selected via `granularity=five_minute` query param on `/api/pjm/rt-lmp/zone`.

---

### 4. `da_marginal_value` — DA Binding Constraint Shadow Prices

| Property | Value |
|---|---|
| Granularity | 1 hour |
| Filter params | `datetime_beginning_ept` |
| Notes | No location filter — returns all binding constraints for the day |

**Key response fields:**

| Field | Type | Description |
|---|---|---|
| `datetime_beginning_ept` | string | Hour interval |
| `datetime_ending_ept` | string | |
| `monitored_facility` | string | Transmission line / transformer |
| `contingency_facility` | string | Contingency that caused binding (null = base case) |
| `shadow_price` | number | $/MWh — positive = congestion rent, negative = relief value |

**Used for:** Binding constraints list, heatmap, monthly constraint frequency ranking. Rows sorted descending by `|shadow_price|` before display.

---

### 5. `rt_marginal_value` — RT Binding Constraint Shadow Prices

Same structure as `da_marginal_value` but for real-time dispatch intervals.

**Used for:** RT binding constraints list, RT heatmap.

---

### 6. `da_transconstraints` — DA Transmission Constraints

| Property | Value |
|---|---|
| Granularity | 1-hour blocks |
| Filter params | `datetime_beginning_ept` |

**Key response fields:**

| Field | Type | Description |
|---|---|---|
| `datetime_beginning_ept` | string | |
| `datetime_ending_ept` | string | |
| `duration` | number | Hours |
| `day_ahead_congestion_event` | string | |
| `monitored_facility` | string | |
| `contingency_facility` | string | |

**Used for:** Transmission constraints panel. Supports optional `monitored` / `contingency` text filters.

---

### 7. `solar_gen` — Solar Generation by Area

| Property | Value |
|---|---|
| Granularity | 1 hour |
| Filter params | `area`, `datetime_beginning_ept` |

Valid `area` values: `RTO`, `MIDATL`, `RFC`, `SOUTH`, `WEST`, `OTHER`

**Key response fields:**

| Field | Type | Description |
|---|---|---|
| `datetime_beginning_ept` | string | |
| `area` | string | Geographic sub-area |
| `solar_generation_mw` | number | Actual MW |

---

### 8. `wind_gen` — Wind Generation by Area

Same structure as `solar_gen` with field `wind_generation_mw`.

Both `solar_gen` and `wind_gen` are fetched in parallel and merged by hour into a single renewables response. A combined `total_renewable_mw = solar + wind` is computed server-side.

---

### 9. `fivemin_marginal_emissions` — Marginal Emissions Rates

| Property | Value |
|---|---|
| Granularity | 5 minutes |
| Filter params | `pnode_id`, `datetime_beginning_ept` |
| **Known restriction** | Does NOT accept `pnode_name` as a filter — use `pnode_id` only |
| **Known restriction** | Cannot sort by `datetime_beginning_utc` — omit sort param |

**Key response fields:**

| Field | Type | Description |
|---|---|---|
| `datetime_beginning_ept` | string | 5-min interval start |
| `pnode_id` | number | |
| `pnode_name` | string | |
| `marginal_co2_rate` | number | lb/MWh |
| `marginal_so2_rate` | number | lb/MWh (typically ~0.002–0.02) |
| `marginal_nox_rate` | number | lb/MWh (typically ~0.001–0.01) |

The server averages 5-min intervals into hourly buckets before returning to the client. SO₂ and NOₓ values are roughly 2 orders of magnitude smaller than CO₂ — the dashboard scales them ×100 on a secondary y-axis for visibility.

**Location resolution logic:**
1. If `pnode_id` is provided directly → use it
2. If `zone` is a known zone code → look up from `ZONE_PNODES` map
3. If `zone` is a text string → query the `pnode` feed to resolve to an ID
4. If no location → fetch RTO-wide (no `pnode_id` filter)

---

### 10. `pnode` — PNode Lookup / Autocomplete

| Property | Value |
|---|---|
| Filter params | `zone`, `pnode_name` |
| TTL (cache) | 1 hour |

Used internally by `resolveEmissionsPnode()` when a zone text string needs converting to a numeric `pnode_id` for the emissions feed.

The dashboard also ships a local `pnodes.csv` (~10k rows) for instant client-side autocomplete without hitting the API. CSV columns: `id, name, type, zone, voltage`.

---

## Zone → PNode ID Mapping

The dashboard maintains a hardcoded map of the 21 PJM load zones plus RTO:

| Zone | PNode ID |
|---|---|
| PJM-RTO | 1 |
| AECO | 51291 |
| AEP | 8445784 |
| APS | 8394954 |
| ATSI | 116013753 |
| BGE | 51292 |
| COMED | 33092371 |
| DAY / DAYTON | 34508503 |
| DEOK | 124076095 |
| DOM | 34964545 |
| DPL | 51293 |
| DUQ | 37737283 |
| EKPC | 970242670 |
| JCPL | 51295 |
| METED | 51296 |
| OVEC | 1709725933 |
| PECO | 51297 |
| PENELEC | 51300 |
| PEPCO | 51298 |
| PPL | 51299 |
| PSEG | 51301 |
| RECO | 7633629 |

Any zone not in this map requires an explicit `pnode_id` query param.

---

## EPT Normalization

PJM returns timestamps in two inconsistent formats depending on the feed:

```
"5/15/2026 1:00:00 AM"   ← M/D/YYYY h:mm:ss AM/PM  (most feeds)
"2026-05-15 01:00"        ← ISO-ish  (some feeds)
```

The server normalises both to `"YYYY-MM-DD HH:MM"` via `normalizeEpt()` before storing or returning data.

---

## Caching

All PJM responses are cached in-process (`Map`) keyed on `{feed, params}`:

| Data type | TTL |
|---|---|
| Daily / hourly data | 5 minutes |
| Monthly data — current month | 5 minutes |
| Monthly data — past months | 24 hours |
| PNode lookup (`pnode` feed) | 1 hour |

Cache resets on process restart. No persistence. Parallel in-flight requests for the same key are not deduplicated (low-risk given rate limiting and typical traffic).

---

## Date Utility Functions

```js
// Single day range (used for all daily handlers)
marketDayRange("2026-05-15")
// → "2026-05-15 00:00 to 2026-05-16 00:00"

// Full month range (used for monthly handlers)
marketMonthRange("2026-04")
// → "2026-04-01 00:00 to 2026-05-01 00:00"

// Cache TTL: 24h for past months, 5min for current month
monthCacheTtl("2026-04")   // → 86400000 (ms)
monthCacheTtl("2026-05")   // → 300000   (ms)  ← if today is May 2026
```

---

## Row Counts by Feed / Period

| Feed | Daily rows (typical) | Monthly rows (typical) |
|---|---|---|
| `da_hrl_lmps` | 24 per zone | ~720 per zone |
| `rt_hrl_lmps` | 24 per zone | ~720 per zone |
| `rt_fivemin_hrl_lmps` | 288 per zone | ~8,640 per zone |
| `da_marginal_value` | 50–300 | 1,500–9,000 |
| `rt_marginal_value` | 50–500 | 1,500–15,000 |
| `da_transconstraints` | 20–200 | 600–6,000 |
| `solar_gen` | 24 per area | ~720 per area |
| `wind_gen` | 24 per area | ~720 per area |
| `fivemin_marginal_emissions` | 288 (RTO) | ~8,640 |

All fit within a single `rowCount=50000` page except potentially `rt_fivemin_hrl_lmps` for a full month (8,640 rows — still well under 50,000).

---

## Known Gotchas & Constraints

| Issue | Detail |
|---|---|
| `fivemin_marginal_emissions` rejects `pnode_name` | Send only `pnode_id` — any name param causes a 400 |
| `fivemin_marginal_emissions` not sortable by UTC | Omit `sort=datetime_beginning_utc` — causes 400 |
| `da_hrl_lmps` revised rows | Use `row_is_current=true` to get the final settled value, not intermediate revisions |
| EPT vs UTC | All dashboard filtering uses EPT. UTC fields are present in the response but not used for display |
| 5-min data crosses midnight UTC | A 23:55 EPT interval has a UTC datetime of the next calendar day — always filter by EPT |
| Daylight saving transitions | On spring-forward days, hour 02:00 EPT is missing (23 intervals); on fall-back, 01:00 EPT appears twice (25 intervals). The dashboard renders gaps/duplicates as-is |
| PJM market day | Runs 00:00–23:00 EPT (the 24th hour ends at midnight, so `datetime_beginning_ept=23:00` is the last interval of day D) |
| API key in URLs | Never log full request URLs when `PJM_AUTH_MODE=query` — the key appears as a query param |

---

## Dashboard Internal API Endpoints

These are the server's own REST endpoints (proxies/aggregators over PJM):

| Method | Path | Key params | PJM feed(s) |
|---|---|---|---|
| GET | `/api/pjm/status` | — | — |
| GET | `/api/pjm/pnodes` | `q` | local CSV |
| GET | `/api/pjm/da-lmp/zone` | `zone`, `date`, `pnode_id` | `da_hrl_lmps` |
| GET | `/api/pjm/da-lmp/zone/monthly` | `zone`, `month` | `da_hrl_lmps` |
| GET | `/api/pjm/rt-lmp/zone` | `zone`, `date`, `granularity` | `rt_hrl_lmps` or `rt_fivemin_hrl_lmps` |
| GET | `/api/pjm/rt-lmp/zone/monthly` | `zone`, `month` | `rt_hrl_lmps` |
| GET | `/api/pjm/dart/monthly` | `zone`, `month` | `da_hrl_lmps` + `rt_hrl_lmps` |
| GET | `/api/pjm/constraints/binding` | `date`, `min_shadow_price`, `monitored`, `contingency` | `da_marginal_value` |
| GET | `/api/pjm/constraints/binding/monthly` | `month` | `da_marginal_value` |
| GET | `/api/pjm/constraints/rt-binding` | `date` | `rt_marginal_value` |
| GET | `/api/pjm/constraints/transmission` | `date`, `monitored`, `contingency` | `da_transconstraints` |
| GET | `/api/pjm/renewables` | `date`, `area` | `solar_gen` + `wind_gen` |
| GET | `/api/pjm/renewables/monthly` | `area`, `month` | `solar_gen` + `wind_gen` |
| GET | `/api/pjm/emissions` | `zone`, `date`, `pnode_id` | `fivemin_marginal_emissions` |
| GET | `/api/pjm/emissions/monthly` | `zone`, `month` | `fivemin_marginal_emissions` |
| POST | `/api/analysis` | body: market data snapshot | — (Gemini / OpenRouter) |
| POST | `/api/chat` | body: `{message, history, context}` | — (Gemini / OpenRouter) |

---

## Adding a New PJM Feed

1. Find the feed name in the [DataMiner 2 catalogue](https://dataminer2.pjm.com/list)
2. Note available filter parameters (shown on the feed's detail page)
3. Add a handler function in `server.js` following the pattern:
   ```js
   async function handleMyFeed(_req, res, url) {
     const date = requireDate(url.searchParams.get("date"));
     const rows = await getPjmRows("my_feed_name", {
       datetime_beginning_ept: marketDayRange(date),
       // ...other filters
     });
     // transform rows, then:
     sendJson(res, 200, { date, rows });
   }
   ```
4. Register it in the `routes` object
5. Call it from the frontend via `fetch('/api/pjm/my-endpoint?...')`

`getPjmRows` handles auth, pagination, caching, and rate limiting automatically.
