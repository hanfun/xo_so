# AGENTS.md — XSMN Prize-8 Algorithm & Development Guide

> **Project:** [hanfun/xo_so](https://github.com/hanfun/xo_so)
> **Last reviewed:** 2026-11-23
> **Status:** V1, V2 (`v2.0.0`) & V3 (`v3.0.0`) implemented, experimental ranking & benchmarking platform (not a validated predictor)
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
Primary third-party XSMN JSON API
  -> fallback Xổ Số VN API when the primary source fails/misses a date
  -> src/lottery.js         # adapt fallback JSON; validate results; extract MN only
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
  -> data/YYYY-MM-DD.json   # opt-in with XSKT_BACKUP_JSON=true; ignored by Git
```

Relevant source files:

| File | Responsibility |
|---|---|
| `src/lottery.js` | Tries the primary API then Xổ Số VN fallback; adapts fallback arrays by station, restricts to `region === 'MN'`, and validates prize counts/digit lengths. |
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

## 4b. V2 algorithm (`v2.0.0`) — multi-component regularized ranking & benchmark evaluation

Implemented in `src/prize8-predictor.js` (`rankPrize8V2`, `backtestPrize8V2`, `analyzeHistoryCoverage`, `wilsonInterval`).

### Parameters (`DEFAULT_V2_PARAMS`)

| Parameter | Default | Valid range | Notes |
|---|---:|---:|---|
| `window` | 52 | Integer 20–200 | Trailing draws used for `P_recent` and V1 baseline comparison. |
| `halfLife` | 12 | Number 2–100 | Exponential decay half-life (in draws) for `P_recent`. |
| `recentWeight` | 0.35 | Number 0–1 | Weight for decayed recent frequency (`35%` in API). |
| `longWeight` | 0.30 | Number 0–1 | Weight for full-history frequency across all draws `< targetDate` (`30%` in API). |
| `digitWeight` | 0.20 | Number 0–1 | Weight for factorized tens × ones digit marginals (`20%` in API). |
| `uniformShrinkage` | 0.15 | Number 0–1 | Explicit shrinkage weight toward uniform `1/100` (`15%` in API). |
| `alpha` | 0.5 | Number (0, 10] | Additive smoothing for 100-bin frequency components. |
| `alphaDigit` | 1 | Number (0, 10] | Additive smoothing for 10-bin tens/ones digit marginals. |
| `topK` | 10 | Integer 1–20 | Displayed top-K candidates. |
| `backtestDraws` | 80 | Integer 1–200 | Max recent walk-forward evaluation draws. |

The four mixture weights must satisfy `recentWeight + longWeight + digitWeight + uniformShrinkage = 1` (within `1e-6`).

### Formula

Given all normalized draws `H` strictly before `targetDate` (length `M >= 20`) and trailing window `R` (length `N = min(M, window)`), for each candidate `s ∈ {00..99}` with tens digit `t = floor(s / 10)` and ones digit `u = s mod 10`:

```text
P_recent(s)  = (D_R(s) + alpha) / (W + 100*alpha)
P_long(s)    = (C_H(s) + alpha) / (M + 100*alpha)
P_digit(s)   = ((C_tens(t) + alphaDigit) / (M + 10*alphaDigit))
             * ((C_ones(u) + alphaDigit) / (M + 10*alphaDigit))
P_uniform(s) = 0.01

Mix_V2(s) = recentWeight * P_recent(s)
          + longWeight   * P_long(s)
          + digitWeight  * P_digit(s)
          + uniformShrinkage * 0.01
```

Each component is normalized to sum to `1` over `00..99`, so `Mix_V2` sums to `1` before rounding. Ranking sorts by unrounded `Mix_V2` descending, breaking ties by full-history `totalObserved` descending, `P_digit` descending, and finally ascending candidate string (`"00"`..`"99"`) — eliminating V1's low-number `"00..09"` tie bias among unseen candidates.

### V2 walk-forward backtest & data coverage

- `backtestPrize8V2` evaluates **four models on identical chronological walk-forward draws** (strictly training on rows `< i`): **V2**, **V1** (default `recentWeight=0.7`), **Raw full-history frequency** (no recency decay), and **Uniform random** (`Top-1 = 1%`, `Top-K = K%`, `LogLoss = ln(100) ≈ 4.60517`, `Brier = 0.99`, `MRR ≈ 0.05187`, `avgRank = 50.5`).
- Reports **Wilson 95% confidence intervals** for Top-1 and Top-K hit rates, lift vs uniform, **Log-loss**, **multiclass Brier score**, **MRR**, and **average actual rank**.
- Flags `isStatisticallySignificantTopK` only when `evaluated >= 30` and the lower 95% Wilson CI exceeds `topK%`.
- `analyzeHistoryCoverage` checks station schedule cadence from `src/station-schedule.js` (e.g. `ho-chi-minh` 2×/week vs 1×/week stations) and reports `coveragePercent`, `missingDraws`, `maxGapDays`, and `gapCount`.

### V3 algorithm (`v3.0.0`) — multi-horizon EWMA + decayed digit marginals + stronger Dirichlet smoothing

Implemented in `src/prize8-predictor.js` (`rankPrize8V3`, `backtestPrize8V3`, `validateV3Parameters`, `DEFAULT_V3_PARAMS`) and exposed via `GET /api/prize8/v3/predict` (and `GET /api/prize8/predict?version=v3`) as well as daily persistence (`POST /api/prize8/daily`).

- Default parameters: `shortHalfLife=6`, `mediumHalfLife=18`, `digitHalfLife=16`, weights `30% / 10% / 15% / 30% / 15%` (`short / medium / long / decayed-digit / uniform`), `alpha=1.0`, `alphaDigit=1.5`.
- Real MySQL benchmark (22 XSMN stations, 1,710 walk-forward draws / 863 untouched holdout draws before `2026-11-23`):
  - All 1,710 draws: V3 Top-1 `1.52%` (V2 `1.29%`), MRR `0.05747` (V2 `0.05505`), Log-loss `4.62518` (V2 `4.66808`).
  - Untouched 863-draw holdout: V3 Top-1 `2.32%` (V2 `1.74%`), Top-10 `11.12%` (V2 `10.66%`), MRR `0.06624` (V2 `0.06049`), Log-loss `4.61801` (V2 `4.65438`).
  - Rejected signals that degraded holdout performance: Lag-1 digit Markov (`Top5 3.36%`), Gap/Overdue (`Top5 3.59%`), Prev-draw all-prize repeat (`Top5 3.48%`).
  - None of the models beat theoretical uniform Log-loss (`4.60517`), consistent with fair independent draws.

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

### V1 & V2 REST endpoints

- V1 (backward-compatible default):
  `GET /api/prize8/predict?date=2026-11-24&province=dong-thap&window=52&halfLife=12&recentWeight=70&topK=10`
- V2 (dedicated endpoint or via `version=v2`):
  `GET /api/prize8/v2/predict?date=2026-11-24&province=dong-thap&window=52&halfLife=12&recentWeight=35&longWeight=30&digitWeight=20&uniformShrinkage=15&topK=10&backtestDraws=80`
  (also accessible at `GET /api/prize8/predict?version=v2&...`).
- V2 returns `modelVersion` (`"v2.0.0"`), `coverage`, `forecast`, `backtest` (with `models.{v2,v1,raw,uniform}` and `comparison`), and `notes`.
- Idempotent daily Top-10 persistence (`model_versions` + `predictions`):
  - `POST /api/prize8/daily` (called automatically when the dashboard opens for today): resolves scheduled stations via `stationsForDate(targetDate)`, generates V2 Top 10 strictly from draws `< targetDate` for any scheduled station not yet stored in `predictions`, persists once inside a locked (`FOR UPDATE`) idempotent transaction, and reads back any already-stored station without regenerating or modifying it.
  - `GET /api/prize8/daily?date=YYYY-MM-DD`: read-only lookup returning saved daily predictions joined with actual `prize_results` (`giai8`, `position=1`), automatically computing `actual`, `actualRank`, `top1Hit`, `top10Hit`, and `status` (`pending`, `top1_hit`, `top10_hit`, `miss`) without altering stored prediction rows.

Frontend controls in `public/index.html` / `public/app.js` allow choosing V2 (default) or V1, station, target date, training window, half-life, and model weights. Display outputs include Top 10 with relative weighted scores, coverage diagnostics, and the 4-model backtest benchmark table. Frontend continues to label these as **experimental ranking**, not odds or a guaranteed winning recommendation.

An additional implemented experimental endpoint, `GET /api/prize8/distribution`, returns all `00..99` for one station and target date. It combines four normalized components whose percentage weights must sum to 100: decayed recent frequency, trailing-window frequency, frequency among observations on the same weekday as the target, and the observed even/odd group share distributed uniformly across the 50 values in that group. Defaults are `40/25/25/10`. It strictly uses rows before the target date and requires 20 observations. The result is a statistical allocation score, not a calibrated winning probability; the UI must retain the fair-draw 1% reference disclaimer.

Historical collection is also available in the dashboard for ranges of at most 10 years. The browser submits one day at a time to `POST /api/collect?date=YYYY-MM-DD&overwrite=false|true` so it can show progress and continue past per-day errors. With `overwrite=false`, the server reads MySQL first and returns the existing snapshot with `cached=true` without contacting a provider. With `overwrite=true`, it forces a validated re-fetch and transactional update.

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

### Implemented vs remaining V2 experiments

- **Implemented in `v2.0.0` (synthetic/mocked tests passing, not yet validated on real MySQL history):**
  - **V2-A (Baselines):** identical chronological walk-forward comparison of V2, V1, Raw full-history frequency, and Uniform random.
  - **V2-C (Confidence & data quality):** Wilson 95% confidence intervals, Log-loss, Brier score, MRR, and station-schedule coverage/gap checks (`analyzeHistoryCoverage`).
  - **V2 multi-component regularized scoring:** full-history frequency + decayed recent frequency + tens/ones digit marginals + uniform prior shrinkage.
  - **V2-D (Daily immutable snapshots):** `POST /api/prize8/daily` and `GET /api/prize8/daily` persist V2 Top-10 snapshots once per `(province, target_date)` into `model_versions` and `predictions` with `FOR UPDATE` idempotency, never overwrite after results arrive, and live-evaluate `actual`, `actualRank`, `top1Hit`, and `top10Hit`.
- **Still proposed (not implemented):**
  - **V2-B (Sensitivity / Nested tuning):** pre-registered `window`, `halfLife`, and weight grids tuned strictly on a prior period and evaluated on an untouched holdout.
  - **V2-D (Evaluation table materialization):** optional batch persistence into `prediction_evaluations` (currently evaluation is computed live from immutable `predictions` + `prize_results`).
  - **V2-E (Extra features):** only after demonstrating additional out-of-sample value without multiple-comparison cherry-picking.

## 9. Definition of done

A new agent's development work is complete only if:

1. Changes are reflected in implementation, automated tests, and this documentation.
2. All date cutoffs are explicit and leakage tests pass.
3. Results and API continue to preserve exact two-character values.
4. The UI transparently distinguishes scoring from actual probability.
5. The comparison to fair-random and to V1 is reproducible.
6. No secret, local DB dump, production lottery result fabrication, or unverified efficacy claim is committed.

**Maintainer note:** This file is an agent-readable specification/handoff for the currently implemented experiment. It deliberately separates observable implementation facts from future proposals. Agents should record any deviation in an explicit PR description before merging.
