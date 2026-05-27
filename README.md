# PJM Market Analyst

A real-time dashboard for monitoring PJM electricity market data — day-ahead and real-time LMPs, DA/RT spreads, binding constraints, renewable generation, and monthly summaries. Runs as a single Node.js process with no external dependencies beyond the PJM Data API.

---

## Features

**Day-Ahead (DA) tab**
- Hourly LMP for any PJM zone or custom PNode, with single / compare / multi-zone / custom modes
- Basis spread between two zones
- Congestion component breakdown by hour
- Top binding constraints with shadow prices and heatmap
- Solar and wind generation by hour
- AI-generated market narrative (via OpenRouter)

**Real-Time (RT) tab**
- Hourly or 5-minute RT LMP for any zone
- RT binding constraints

**DART Spread tab**
- Hour-by-hour DA vs RT spread with bar chart and sortable table
- KPIs: average spread, max RT premium, max DA overshoot, hours RT ran above DA

**Monthly view** (toggle on every tab)
- Daily avg/max LMP, daily avg congestion, daily avg renewables
- Monthly binding constraint frequency — top 15 facilities ranked by hours active
- Daily avg DART spread across the month
- Past months cache for 24 hours; current month refreshes every 5 minutes

---

## Screenshots

| Day-Ahead — Multi-zone |
|---|
| <img width="2485" height="1165" alt="image" src="https://github.com/user-attachments/assets/03c7e877-0c3f-48cc-8e23-e61ccf50dd18" />
 | <img width="2394" height="1034" alt="image" src="https://github.com/user-attachments/assets/79a2b70e-3c02-45af-a172-35fcc873bac2" /> |

---

## Requirements

- Node.js ≥ 20
- A [PJM Data API](https://dataminer2.pjm.com/list) subscription key
- _(Optional)_ A [Google Gemini API](https://aistudio.google.com/apikey) key for AI analysis (or an [OpenRouter](https://openrouter.ai) key as fallback)

---

## Quick Start

```bash
git clone https://github.com/gokulk96/pjm_monitor.git
cd pjm_monitor
cp .env.example .env
# Edit .env and set PJM_API_KEY
node server.js
```

Open `http://localhost:3000`.

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `PJM_API_KEY` | **Yes** | — | PJM Data API subscription key |
| `PJM_API_BASE_URL` | No | `https://api.pjm.com/api/v1` | PJM API base URL |
| `PJM_AUTH_MODE` | No | `header` | `header`, `query`, or `both` |
| `PJM_RATE_LIMIT_PER_MINUTE` | No | `6` | Max PJM API calls per minute |
| `PJM_TIMEOUT_SECONDS` | No | `30` | Per-request timeout in seconds |
| `GEMINI_API_KEY` | No | — | Enables AI analysis via Google Gemini (preferred) |
| `GEMINI_MODEL` | No | `gemini-2.0-flash` | Gemini model to use |
| `OPENROUTER_API_KEY` | No | — | Fallback AI provider if `GEMINI_API_KEY` is not set |
| `OPENROUTER_MODEL` | No | `deepseek/deepseek-v4-flash` | OpenRouter model to use |
| `OPENROUTER_SITE_URL` | No | `http://localhost:3000` | Sent as HTTP-Referer to OpenRouter |
| `OPENROUTER_APP_NAME` | No | `PJM Market Analyst` | Sent as X-Title to OpenRouter |
| `ACCESS_TOKEN` | No | _(empty = open)_ | Bearer token to restrict access |
| `PORT` | No | `3000` | HTTP port |

Copy `.env.example` to `.env` and fill in the values.

---

## API Endpoints

All endpoints return JSON. Date parameters use `YYYY-MM-DD`; month parameters use `YYYY-MM`.

### Status
| Method | Path | Description |
|---|---|---|
| GET | `/api/pjm/status` | Server health and configuration |

### Day-Ahead LMP
| Method | Path | Key params | Description |
|---|---|---|---|
| GET | `/api/pjm/da-lmp/zone` | `zone`, `date`, `pnode_id` | Hourly DA LMP for a zone or PNode |
| GET | `/api/pjm/da-lmp/zone/monthly` | `zone`, `month` | Daily aggregated DA LMP for a full month |

### Real-Time LMP
| Method | Path | Key params | Description |
|---|---|---|---|
| GET | `/api/pjm/rt-lmp/zone` | `zone`, `date`, `granularity` | Hourly or 5-min RT LMP |
| GET | `/api/pjm/rt-lmp/zone/monthly` | `zone`, `month` | Daily aggregated RT LMP for a full month |

### DART Spread
| Method | Path | Key params | Description |
|---|---|---|---|
| GET | `/api/pjm/dart/monthly` | `zone`, `month` | Daily avg DA/RT spread for a full month |

### Constraints
| Method | Path | Key params | Description |
|---|---|---|---|
| GET | `/api/pjm/constraints/binding` | `date` | DA binding constraints with shadow prices |
| GET | `/api/pjm/constraints/binding/monthly` | `month` | Monthly constraint frequency — top 15 facilities |
| GET | `/api/pjm/constraints/rt-binding` | `date` | RT binding constraints |
| GET | `/api/pjm/constraints/transmission` | `date` | DA transmission constraints |

### Renewables
| Method | Path | Key params | Description |
|---|---|---|---|
| GET | `/api/pjm/renewables` | `date`, `area` | Hourly solar and wind generation |
| GET | `/api/pjm/renewables/monthly` | `month`, `area` | Daily avg renewable generation for a month |

### Emissions
| Method | Path | Key params | Description |
|---|---|---|---|
| GET | `/api/pjm/emissions` | `zone`, `date` | Hourly avg marginal CO₂, SO₂, NOₓ (lb/MWh) |
| GET | `/api/pjm/emissions/monthly` | `zone`, `month` | Daily avg marginal emissions for a month |

### PNode Search
| Method | Path | Key params | Description |
|---|---|---|---|
| GET | `/api/pjm/pnodes` | `q` | Autocomplete search across ~10k PNodes |

### AI Analysis
| Method | Path | Description |
|---|---|---|
| POST | `/api/analysis` | Generates a markdown market narrative from the current view's data |

---

## Caching

All PJM API responses are cached in memory on the server.

| Data type | TTL |
|---|---|
| Hourly day data | 5 minutes |
| Monthly data — current month | 5 minutes |
| Monthly data — past months | 24 hours |

The cache resets on server restart. There is no persistence layer.

---

## Deploy to Railway

1. Fork or push this repo to GitHub
2. Create a new Railway project → **Deploy from GitHub repo**
3. Add environment variables in the Railway dashboard (at minimum `PJM_API_KEY`)
4. Railway auto-detects `npm start` from `package.json` — no additional config needed

---

## PJM Data Feeds Used

| Feed | Description |
|---|---|
| `da_hrl_lmps` | Day-ahead hourly LMPs |
| `rt_hrl_lmps` | Real-time hourly LMPs |
| `rt_fivemin_hrl_lmps` | Real-time 5-minute LMPs |
| `da_marginal_value` | DA binding constraint shadow prices |
| `rt_marginal_value` | RT binding constraint shadow prices |
| `da_transconstraints` | DA transmission constraints |
| `solar_gen` | Solar generation by area |
| `wind_gen` | Wind generation by area |
| `fivemin_marginal_emissions` | 5-minute marginal CO₂, SO₂, NOₓ rates (lb/MWh) |

All data is sourced from the [PJM DataMiner 2 API](https://dataminer2.pjm.com/list).

---

## License

MIT
