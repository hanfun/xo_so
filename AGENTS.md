# AGENTS.md — XSMN Prize-8 Algorithm & Development Guide

> **Project:** [hanfun/xo_so](https://github.com/hanfun/xo_so)
> **Last reviewed:** 2026-11-23
> **Status:** V1 implemented, experimental weighted-frequency ranking (not a validated predictor)
> **Primary language:** Vietnamese for UI and docs; JavaScript ES modules for code.

## 0. Read this first (instructions for coding agents)

This is the canonical handoff document for the **Xổ số kiến thiết miền Nam (XSMN) giải 8** experiment. Before changing the algorithm:

1. Read `src/prize8-predictor.js`, `src/mysql-store.js`, `src/server.js`, `tests/prize8-predictor.test.js`, and `db/migrations/001_initial.sql`. This document describes the current implementation; **actual source code is authoritative** if it changes.
2. Keep the existing app running on **Node.js 20+ and local MySQL 8+**, with the dashboard at `http://127.0.0.1:3000`.
3. **XSMN only**. In V1 the algorithm ranks **giải 8 only** for **one station at a time**. Do not silently combine other prize tiers, provinces, or XSMB/XSMT.
4. Preserve the complete string value of each prize number, including leading zeroes: `"00"`, `"07"`, etc. Never cast stored prize numbers to integers.
5. Never train/evaluate on a draw dated **on or after the prediction target date**. Use chronological walk-forward tests for historical evaluation.
6. Do not expose credentials, change `.env` handling, or commit MySQL records/JSON backups to Git.
7. **Do not present ranking scores as proven probabilities or promise a winning edge.** A fair, independent draw gives each two-digit number the same 1% chance; historical weighting by itself does not change that.
8. Add tests for all behavior changes, run `npm test`, and record experiment parameters and results if a V2 is introduced.
9. Distinguish **implemented**, **proposed**, and **untested on real data** features. GitHub CI currently tests mocked/synthetic data; it does not verify the user's local MySQL or third-party API.

## 1. Project goal and boundaries

- Gather and store historical **XSMN** results in local MySQL.
- Analyze results by **station (`province`), prize tier, and date**.
- V1 experiment: use previous **giải 8** numbers of a **single station** to rank all `00..99` with heavier weighting on recent draws.
- Display a Top-10 **ranking**, plus a chronological backtest against uniform-random baselines.
- Do **not** label V1 as a scientifically demonstrated prediction system.

For a fair lottery with independent draws, recent outcomes do not provide evidence of a statistically reliable edge. The primary engineering objective is a **reproducible experiment and evaluation platform**, not a guarantee of future results.

## 2. Architecture and source of truth

```text
Third-party XSMN JSON API
  -> src/lottery.js         # validate results; extract MN only
  -> src/collector.js       # collect, throttle, preserve valid prior results
  -> src/mysql-store.js     # MySQL transaction; normalized draws/prizes
  -> local MySQL database   # authoritative result history
       |       \
       |        -> src/mysql-store.js:getPrize8History()
       |               -> src/prize8-predictor.js
       |                    -> ranking + walk-forward backtest
       |                          -> src/server.js
       |                              GET /api/prize8/predict
       |                                -> public/app.js / index.html
       -> other statistics via /api/stats
  -> data/YYYY-MM-DD.json   # optional local backup, ignored by Git
```

Relevant source files:

| File | Responsibility |
|---|---|
| `src/lottery.js` | Restricts to `region === 'MN'`; validates individual prize counts and digit lengths. |
| `src/collector.js` | Collects a draw date, writes MySQL and optional JSON backup. |
| `src/mysql-store.js` | Stores normalized draw/prize rows; queries prize-8 history before the target date. |
| `src/prize8-predictor.js` | Pure ranking algorithm, parameter validation, normalization, walk-forward backtest. |
| `src/server.js` | REST endpoint and validation of query parameters. |
| `public/index.html`, `public/app.js`, `public/style.css` | Local dashboard and ranking/backtest display. |
| `tests/prize8-predictor.test.js` | Synthetic and mock database/API tests for V1. |
| `db/migrations/001_initial.sql` | MySQL schema; includes unused scaffolding for future ML metadata. |

### MySQL data model

- `provinces(id, region, code, name)`: station identity. `region='MN'` for this project.
- `draws(id, province_id, draw_date, ...)`: one draw per station/day, uniquely constrained by `(province_id, draw_date)`.
- `prize_results(draw_id, prize_code, position, number)`: individual prize results. **`number` is VARCHAR**, not INT.
- `source_snapshots`: provider/result JSON per day and provenance.
- `features`, `model_versions`, `predictions`, `prediction_evaluations`: **prepared tables**, not currently used by the V1 ranking endpoint. Do not claim V1 predictions are persisted to these tables.

Current V1 fetch from `src/mysql-store.js:getPrize8History({province, before, limit=500})`:

```sql
SELECT p.code AS province, p.name AS name,
       DATE_FORMAT(d.draw_date,'%Y-%m-%d') AS date, r.number
FROM prize_results r
JOIN draws d ON d.id=r.draw_id
JOIN provinces p ON p.id=d.province_id
WHERE p.region='MN'
  AND p.code = ?
  AND r.prize_code='giai8'
  AND r.position=1
  AND d.draw_date < ?
ORDER BY d.draw_date DESC
LIMIT ?;
```

The implementation reverses the descending query results to ascending chronological order before ranking. SQL parameters are bound, not interpolated. The hard fetch limit is currently **500 historical rows** per station.

## 3. Data contract and invariants

One valid training row:

```json
{ "date": "2026-11-16", "number": "07" }
```

The database adapter additionally supplies `province` and `name`. For **one station**, each valid date should contain **exactly one giải 8 result**, a **two-character digit string** matching `/^[0-9]{2}$/`.

The current `normalizeHistory(history)`:

1. Keeps entries whose `date` matches the string pattern `YYYY-MM-DD` and whose `number` is exactly two digit characters.
2. Deduplicates matching date + number; **throws** if the same date has conflicting numbers.
3. Sorts ascending by date. Invalid rows are silently filtered by this V1 helper; any stricter quality audit belongs in a separately tested enhancement.

`rankPrize8(history, targetDate, options)` further filters `row.date < targetDate`, then uses the **last `window` observations**, not a calendar-day window. The absolute date gap does not affect the current recency weight: recency is measured in **draw index**, not elapsed days.

**Never:** convert `"07"` to `7` in storage, include the target day's result, pool multiple stations without explicitly defining a new model, or backfill absent rows with fake numbers.

## 4. V1 algorithm — exact mathematical definition

### Parameters

| Parameter | Default | Valid range in code | Notes |
|---|---:|---:|---|
| `MIN_HISTORY` | 20 | Fixed | Minimum training observations to emit any ranking. |
| `window` | 52 | Integer 20–200 | Last N *draws* (not days). |
| `halfLife` | 12 | Number 2–100 | Half-life measured in draw counts. |
| `recentWeight` | 0.7 | Number 0–1 | Mix weight for exponentially decayed frequency. |
| `alpha` | 0.5 | Number (0, 10] | Additive smoothing for each of 100 numbers. |
| `topK` | 10 | Integer 1–20 | Number of displayed candidate ranks. |
| `backtestDraws` | 80 | Integer 1–200 | Max recent walk-forward evaluation draws. |

The current HTTP API exposes `window`, `halfLife`, `topK`, and `recentWeight` as a **percentage in `0..100`** (e.g. `70`, converted to `0.7` in `src/server.js`). `alpha=0.5` and `backtestDraws=80` are currently fixed by the API.

### Formula

Let `x_0` be the **newest** historical giải 8 result, `x_1` the previous result, etc., for `N` selected draws. For each candidate `s ∈ {00,...,99}`:

**Recency weight** for observation `k`:

```text
w(k) = 2^(-k / halfLife)               k = 0 ... N-1
```

**Raw frequency** and **weighted frequency**:

```text
C(s) = Σ [x_k == s]
D(s) = Σ w(k) * [x_k == s]
W    = Σ w(k)
```

**Smoothed scores** for the two frequency components (100 possible outcomes):

```text
P_long(s)   = (C(s) + alpha) / (N + 100*alpha)
P_recent(s) = (D(s) + alpha) / (W + 100*alpha)
Mix(s)      = recentWeight * P_recent(s)
            + (1-recentWeight) * P_long(s)
DisplayedScore(s) = round(100 * Mix(s), 5)
```

`Mix` sums to 1 over all 100 candidates **mathematically**, before rounding. It is a **smoothed frequency-based ranking score** rather than an empirically calibrated future-hit probability. A larger score does not establish a true predictive advantage.

Sort **descending** by `DisplayedScore`; tie-break by the candidate number in **ascending** string order (`"00"` before `"01"`). Each ranked item contains:

```json
{
  "number": "07",
  "score": 1.23456,
  "observed": 2,
  "weightedCount": 1.3456,
  "lastSeen": "2026-11-16"
}
```

The numeric values above are **illustrative schema values, not actual lottery statistics or a computed forecast**.

### Equivalent pseudocode

```text
validate parameters
history = normalizeHistory(history)
history = history where date < targetDate
recent = last window observations
if len(recent) < 20:
    return status="insufficient_history", top=[]

for candidate in "00".."99":
    raw = count(candidate occurrences in recent)
    weighted = sum(2^(-ageIndex / halfLife) for matching occurrences)
    long = (raw + alpha) / (len(recent) + 100*alpha)
    recent = (weighted + alpha) / (sum(all decays) + 100*alpha)
    score = round(100*(recentWeight*recent + (1-recentWeight)*long), 5)
sort descending by score, ascending by candidate number on ties
return topK candidates and trainingEnd (latest training draw date)
```

## 5. Walk-forward backtest — no future leakage

Function: `backtestPrize8(history, targetDate, options)`.

1. Normalize and filter historical rows strictly before `targetDate`.
2. Start at observation index `max(20, totalHistoryRows - backtestDraws)`.
3. For each eligible index `i` in ascending order, compute a ranking using **only rows at indexes < i**, selecting up to `window` of them.
4. Compare the rank-1 candidate and the set of `topK` **distinct** candidates against the **actual row at index `i`**.
5. Count hits and evaluate rates:

```text
top1RatePercent = 100 * top1Hits / evaluated
topKRatePercent = 100 * topKHits / evaluated
```

6. Show reference baselines for a fair independent draw: **Top 1 = 1%**, **Top K = K%** (10% when K=10).
7. If fewer than 30 evaluation draws exist, emit a small-sample warning. If fewer than 20 training observations exist, no ranking is issued.

Important distinction: this is **walk-forward with growing available history** and a fixed-size trailing ranking window. It is not cross-validation with random train/test shuffling. Never tune parameters on the evaluation period and then claim that same period is an unbiased test.

### Current V1 limitations in backtesting

- Only overall Top-1 and Top-K hit rates are computed.
- No uncertainty intervals, randomized baseline simulations, calibration assessment, or out-of-sample holdout beyond the rolling backtest.
- An API query can request a historical `targetDate`; the same strict pre-target cutoff must still be enforced.
- Historical source corrections may not represent the information actually available at the older prediction time; consider data-as-of snapshots for research-grade replay.
- Comparing configurations on the same 80 draws can overfit. Prefer a separated tuning period and untouched final holdout for future V2 experiments.

## 6. API contract and user interface

```http
GET /api/prize8/predict?date=2026-11-24&province=dong-thap&window=52&halfLife=12&recentWeight=70&topK=10
```

- `date`: the target draw date in `YYYY-MM-DD` format; when omitted, server defaults to today in `Asia/Ho_Chi_Minh`.
- `province`: **required** code of one XSMN station, from `GET /api/stations`.
- `window`, `halfLife`, `recentWeight` (percent), `topK`: optional, validated.
- The response contains `province`, `name`, `targetDate`, `historyCount`, `forecast`, `backtest`, and `notes`.
- `forecast.status` is `experimental` or `insufficient_history`. Its `top` list is empty when insufficient.
- `forecast.trainingEnd` is the newest date in the training window or `null`.
- `forecast.params.recentWeight` is the internal fraction (`0.7`), **not the API percentage** (`70`).
- The endpoint currently computes in-memory on each request; it **does not write** to the `predictions` table.

Frontend controls in `public/index.html` / `public/app.js` allow station, target date, training window, half-life and recency share. Display outputs include Top 10 with relative weighted scores and the backtest benchmarks. Frontend should continue to label these as **experimental ranking**, not odds or a guaranteed winning recommendation.

## 7. Run, verify, and debug

```bash
git clone https://github.com/hanfun/xo_so.git
cd xo_so
npm install
# Copy .env.example to .env and set your LOCAL MySQL credentials
npm run db:init
npm test
npm start
```

For new local history data, import at most 366 days per command:

```bash
npm run history:import -- 2025-01-01 2025-12-31
npm run history:import -- 2026-01-01 2026-11-23
```

The third-party provider can be unavailable or lack past dates. **Do not generate fictitious production history** when missing. Review `README.md` for details and restrictions.

Current test coverage in `tests/prize8-predictor.test.js` checks:

- Greater weighting of recent patterns and preservation of leading zeroes.
- No leakage from draws on/after target date.
- Insufficient sample behavior.
- Rolling hit-rate arithmetic and uniform reference baselines.
- Invalid parameters and conflicting duplicate-date rows.
- MySQL query filters one XSMN station and strictly pre-target dates.
- HTTP endpoint success and validation behavior.

These are **synthetic/mocked tests**. A passing CI build is not proof of predictive accuracy on actual draw data or of compatibility with the user's local MySQL.

## 8. Agent implementation checklist for V2

For each proposed change:

- [ ] Define a hypothesis and exact target (always specific station + giải 8 unless intentionally versioning a new experiment).
- [ ] Define training cutoff and dataset snapshot; prevent post-target information from entering any features or parameter selection.
- [ ] Maintain `00..99` as fixed-width strings throughout storage, ranking, evaluation, and UI.
- [ ] Record model version, parameter set, seed (if randomized), training range, data-source/provenance version, and generated time.
- [ ] Evaluate against **uniform random Top-1/Top-K**, V1, and a simple no-recency frequency baseline.
- [ ] Split training / tuning / final untouched test periods **chronologically**, independently for each station.
- [ ] Report sample size, coverage, missing dates and stations, hit rates, uncertainties (e.g. confidence intervals), and lift vs baseline; avoid claiming an edge from small samples.
- [ ] Backtest with deterministic fixtures, edge cases (no history, exactly 20, 00, 99, duplicates, missing draws), and no-lookahead tests.
- [ ] Version persisted predictions in dedicated tables only after designing proper migration and idempotent writes; keep observed results immutable/auditable.
- [ ] Preserve existing REST API behavior or document a versioned, backward-compatible change.
- [ ] Update this document and `README.md` whenever formulas, SQL schema, parameters, or API responses change.
- [ ] Run `npm test` and verify CI; test against an actual MySQL instance only in a controlled development environment.

### Suggested experiments (not implemented)

- **V2-A: Baselines first:** compare uniform random, uniform prior (all candidates tied), raw trailing-frequency, and V1 weighted-frequency on identical chronological evaluation periods.
- **V2-B: Sensitivity:** pre-register `window`, `halfLife`, and `recentWeight` grids; tune only on a prior period and measure the untouched future holdout.
- **V2-C: Confidence and data quality:** bootstrapped uncertainty where appropriate, data coverage metrics, source revision audit, station-specific draw-schedule checks.
- **V2-D: Persistence:** add immutable experiment runs and prediction snapshot records with training cutoff and algorithm version; **do not update outcome records or retroactively overwrite previously published predictions**.
- **V2-E: Extra features** only after demonstrating additional out-of-sample value; do not introduce ML complexity or multiple-comparison cherry-picking without evaluation.

## 9. Definition of done

A new agent's development work is complete only if:

1. Changes are reflected in implementation, automated tests, and this documentation.
2. All date cutoffs are explicit and leakage tests pass.
3. Results and API continue to preserve exact two-character values.
4. The UI transparently distinguishes scoring from actual probability.
5. The comparison to fair-random and to V1 is reproducible.
6. No secret, local DB dump, production lottery result fabrication, or unverified efficacy claim is committed.

**Maintainer note:** This file is an agent-readable specification/handoff for the currently implemented experiment. It deliberately separates observable implementation facts from future proposals. Agents should record any deviation in an explicit PR description before merging.
