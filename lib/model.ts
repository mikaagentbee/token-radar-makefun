// Token Radar's model: one sealed snapshot in, one ranked board of pre-token protocols out.
//
// The board ranks protocols that record no token yet. Every slug on the snapshot's watchlist is on
// the board (the floor, never the ceiling). Beyond it, the radar ranks every other pre-token
// protocol that passes the same hygiene the house applied to its watchlist: an exchange product, a
// versioned pool of another protocol, or a wrapped or staked wrapper of a token that already trades
// is a product, not a launch candidate, and is set aside rather than ranked.
//
// Implied value is fitted, not hand-set. Two models are fitted on the snapshot itself, and every
// candidate term has to earn its place in held-out tests before it is used:
//
//   value if it launches = exp(a + b x ln TVL + kept terms + category effect), fitted by least
//                          squares on the snapshot's priced, non-product tokens (the size curve)
//   token odds           = a logistic fit on the snapshot's non-product peers (whether a peer
//                          records a token), on the terms that survived the same tests
//   implied value        = token odds x value if it launches
//
// Each term is added in order and scored out of sample (leave-one-out and walk-forward for the
// value model, ten-fold and walk-forward Brier for the odds). A term is kept only when both tests
// improve; the dashboard prints the whole ladder, the fitted coefficients with bootstrap standard
// errors, and the coverage of the printed ranges, so a reader can see what the tests forced out.
// Ranges and rank ranges come from bootstrap refits of both models. No protocol name is ever
// special-cased: the same code scores every row, and the dashboard recomputes every row from the
// shipped coefficients and compares it with board.json.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's version label: the dashboard names it and board.json carries it. */
export const MODEL_VERSION = 'fitted-odds-3';

/** Farm-plan economics at the dashboard's default controls. The page ships these and recomputes
 *  every verdict live when a reader moves a control; the board's printed verdicts use them too. */
export const FARM = {
  plan_pct: 0.0002, // deposit = this share of the protocol's TVL, clamped below
  dep_min: 50,
  dep_max: 250,
  drop_share: 0.07, // share of a launch's value the house scenario gives to farmers
  horizon_wk: 12,
  participation: 0.02, // share of TVL assumed to be actively farming alongside the reader
  funding_apr: 0.045, // capital charge on the deposit
  swap_pct: 0.003, // round-trip swap cost on the deposit
  bar_net: 50, // a FARM verdict needs at least this net, and the hourly bar below
  bar_hour: 25,
};

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const at = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)));
  return sorted[at]!;
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

function sd(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((a, b) => a + (b - m) * (b - m), 0) / (values.length - 1));
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Deterministic RNG (mulberry32) so bootstrap refits are the same on every run. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a over a string, as 8 hex digits: the board's checksum, recomputed in the browser. */
export function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Whole days from `listedAt` to the snapshot's `asOf`, clamped at zero; null when unrecorded. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** Whether a protocol records no token at all: no market cap, no CoinGecko id, no symbol. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Categories whose entries are products of another protocol or an exchange, per the watchlist rule. */
const PRODUCT_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);

/** Exchanges whose names open a product's name, per the watchlist rule. */
const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

/** A name ending in a version marker is a pool of another protocol, per the watchlist rule. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** A whole word wrapped, staked or staking marks a wrapper of a token that already trades. */
const WRAPPER_WORD = /\b(wrapped|staked|staking)\b/i;

/** Whether a protocol is a product of another protocol or an exchange, whatever its token record. */
export function isProduct(p: SnapshotProtocol): boolean {
  if (PRODUCT_CATEGORIES.has(p.category ?? '')) return true;
  if (VERSIONED.test(p.name)) return true;
  if (WRAPPER_WORD.test(p.name)) return true;
  if (EXCHANGE_PREFIXES.some((x) => p.name === x || p.name.startsWith(`${x} `))) return true;
  return false;
}

/** The one reason a set-aside pre-token protocol is set aside, in the house's own groupings. */
export function setAsideReason(p: SnapshotProtocol): 'bridge' | 'staking' | 'exchange' | 'versioned' {
  const c = p.category ?? '';
  if (c === 'Bridge' || c === 'Canonical Bridge') return 'bridge';
  if (c === 'Liquid Staking' || c === 'Liquid Restaking' || c === 'Restaked BTC') return 'staking';
  if (c === 'CEX' || EXCHANGE_PREFIXES.some((x) => p.name === x || p.name.startsWith(`${x} `))) return 'exchange';
  return 'versioned';
}

/**
 * Whether a pre-token protocol is a launch candidate rather than a product:
 * the watchlist's own hygiene, applied to every row of the board.
 */
export function isLaunchCandidate(p: SnapshotProtocol): boolean {
  return isPreToken(p) && !isProduct(p);
}

// ---------------------------------------------------------------------------
// Small linear algebra: least squares through the normal equations, and a
// logistic fit by iteratively reweighted least squares. No dependencies.
// ---------------------------------------------------------------------------

/** Solve A x = b by Gaussian elimination with partial pivoting. */
function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r]![col]!) > Math.abs(M[piv]![col]!)) piv = r;
    const tmp = M[col]!; M[col] = M[piv]!; M[piv] = tmp;
    const d = M[col]![col]! || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r]![col]! / d;
      if (f === 0) continue;
      for (let c = col; c <= n; c++) M[r]![c]! -= f * M[col]![c]!;
    }
  }
  return M.map((row, i) => row[n]! / (row[i]! || 1e-12));
}

/** Ordinary least squares with a small ridge on the slopes: returns the coefficients. */
function ols(X: number[][], y: number[], ridge = 1e-8): number[] {
  const k = X[0]!.length;
  const A: number[][] = Array.from({ length: k }, () => new Array(k).fill(0));
  const b = new Array(k).fill(0);
  for (let i = 0; i < X.length; i++) {
    const xi = X[i]!;
    for (let r = 0; r < k; r++) {
      b[r] += xi[r]! * y[i]!;
      for (let c = 0; c < k; c++) A[r]![c] += xi[r]! * xi[c]!;
    }
  }
  for (let r = 1; r < k; r++) A[r]![r] += ridge;
  return solve(A, b);
}

const sigmoid = (z: number): number => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
const logit = (p: number): number => Math.log(Math.min(0.999, Math.max(0.001, p)) / (1 - Math.min(0.999, Math.max(0.001, p))));

/** Logistic regression by IRLS with a small ridge on the slopes. `offset` is added to every logit. */
function logisticFit(X: number[][], y: number[], offset: number[], ridge = 0.05): number[] {
  const k = X[0]!.length;
  const base = Math.min(0.99, Math.max(0.01, mean(y)));
  let beta = new Array(k).fill(0);
  beta[0] = logit(base);
  for (let iter = 0; iter < 40; iter++) {
    const A: number[][] = Array.from({ length: k }, () => new Array(k).fill(0));
    const b = new Array(k).fill(0);
    for (let i = 0; i < X.length; i++) {
      const xi = X[i]!;
      let z = offset[i]!;
      for (let c = 0; c < k; c++) z += xi[c]! * beta[c]!;
      const p = sigmoid(z);
      const w = Math.max(1e-6, p * (1 - p));
      const work = z + (y[i]! - p) / w;
      for (let r = 0; r < k; r++) {
        b[r] += xi[r]! * w * work;
        for (let c = 0; c < k; c++) A[r]![c] += xi[r]! * w * xi[c]!;
      }
    }
    for (let r = 1; r < k; r++) A[r]![r] += ridge;
    const next = solve(A, b);
    const delta = Math.max(...next.map((v, i) => Math.abs(v - beta[i]!)));
    beta = next;
    if (delta < 1e-9) break;
  }
  return beta;
}

// ---------------------------------------------------------------------------
// The value model: what a token would be worth if the protocol launched one,
// fitted on the snapshot's priced, non-product tokens.
// ---------------------------------------------------------------------------

/** Features the value ladder may use, in the order the ladder adds them. */
type ValueTerm = 'lnTvl' | 'growth' | 'years' | 'lnChains' | 'control';

interface ValueRow {
  p: SnapshotProtocol;
  lnTvl: number;
  growth: number;
  years: number;
  lnChains: number;
  control: number;
  lnCap: number;
  cat: string;
}

interface ValueFit {
  flat: number; // median cap/TVL of the fit rows (the flat baseline)
  beta: number[]; // coefficients over the active regressors, intercept first
  terms: ValueTerm[];
  catEffects: Map<string, number>;
  medianYears: number;
}

const VALUE_LADDER: { label: string; add: ValueTerm | 'flat' | 'cat' }[] = [
  { label: 'flat median multiple', add: 'flat' },
  { label: '+ size curve, ln TVL', add: 'lnTvl' },
  { label: '+ category effect', add: 'cat' },
  { label: '+ 7-day TVL growth', add: 'growth' },
  { label: '+ age, years', add: 'years' },
  { label: '+ chain count, ln', add: 'lnChains' },
  { label: '+ control (another row)', add: 'control' },
];

function valueRows(snapshot: Snapshot): ValueRow[] {
  const fit = snapshot.protocols.filter((p) => !isProduct(p) && p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0);
  const dated = fit.map((p) => ageDays(snapshot.as_of, p.listed_at)).filter((d): d is number => d !== null);
  const medYears = (dated.length ? median(dated) : 0) / 365.25;
  const sorted = [...fit].sort((a, b) => (a.slug < b.slug ? -1 : 1));
  return sorted.map((p, i) => {
    const days = ageDays(snapshot.as_of, p.listed_at);
    return {
      p,
      lnTvl: Math.log(p.tvl_usd),
      growth: finite(p.change_7d, 0),
      years: days === null ? medYears : days / 365.25,
      lnChains: Math.log(Math.max(1, p.chains.length)),
      control: finite(sorted[(i + 1) % sorted.length]!.change_7d, 0),
      lnCap: Math.log(p.mcap_usd!),
      cat: p.category ?? '',
    };
  });
}

function design(row: ValueRow, terms: ValueTerm[]): number[] {
  const x = [1, row.lnTvl];
  for (const t of terms) {
    if (t === 'growth') x.push(row.growth);
    else if (t === 'years') x.push(row.years);
    else if (t === 'lnChains') x.push(row.lnChains);
    else if (t === 'control') x.push(row.control);
  }
  return x;
}

/** Fit one ladder step's procedure on training rows: OLS, then shrunk category offsets. */
function fitValueStep(rows: ValueRow[], terms: ValueTerm[], useCat: boolean): ValueFit {
  const flat = median(rows.map((r) => Math.exp(r.lnCap - r.lnTvl)));
  const beta = ols(rows.map((r) => design(r, terms)), rows.map((r) => r.lnCap));
  const catEffects = new Map<string, number>();
  if (useCat) {
    const byCat = new Map<string, number[]>();
    for (const r of rows) {
      const pred = design(r, terms).reduce((s, v, i) => s + v * beta[i]!, 0);
      const list = byCat.get(r.cat) ?? [];
      list.push(r.lnCap - pred);
      byCat.set(r.cat, list);
    }
    for (const [cat, resid] of byCat) catEffects.set(cat, resid.reduce((a, b) => a + b, 0) / (resid.length + 16));
  }
  return { flat, beta, terms, catEffects, medianYears: median(rows.map((r) => r.years)) };
}

function predictValue(fit: ValueFit, row: ValueRow, step: number): number {
  if (step === 0) return Math.log(fit.flat) + row.lnTvl;
  const base = design(row, fit.terms).reduce((s, v, i) => s + v * fit.beta[i]!, 0);
  return base + (fit.catEffects.get(row.cat) ?? 0);
}

/** The typical miss factor of a set of log predictions: exp(median |ln actual - ln pred|),
 *  the factor a typical row is off by; 1 is perfect. */
function missFactor(actual: number[], pred: number[]): number {
  return Math.exp(median(actual.map((a, i) => Math.abs(a - pred[i]!))));
}

interface TermResult {
  label: string;
  test_a_label: string;
  test_a: number;
  test_b_label: string;
  test_b: number;
  stamp: string; // 'baseline' | 'kept' | 'tested, not kept' | 'must not help'
}

/** Run the value ladder: each step scored leave-one-out and walk-forward (earlier-listed fit the
 *  model, later-listed are priced by it). A term is kept only when both tests improve. */
function runValueLadder(rows: ValueRow[]): { ladder: TermResult[]; kept: { terms: ValueTerm[]; useCat: boolean } } {
  const dated = rows.filter((r) => r.p.listed_at !== null).sort((a, b) => (a.p.listed_at! < b.p.listed_at! ? -1 : 1));
  const half = Math.floor(dated.length / 2);
  const train = dated.slice(0, half);
  const test = dated.slice(half);
  const ladder: TermResult[] = [];
  let terms: ValueTerm[] = [];
  let useCat = false;
  let prev: { loo: number; wf: number } | null = null;
  const keptTerms: ValueTerm[] = [];
  let keptCat = false;
  VALUE_LADDER.forEach((stepDef, step) => {
    if (stepDef.add === 'lnTvl') terms = ['lnTvl'];
    else if (stepDef.add === 'cat') useCat = true;
    else if (stepDef.add !== 'flat') terms = [...terms, stepDef.add as ValueTerm];
    // Leave-one-out over every fit row.
    const looPred = rows.map((row, i) => {
      const sub = rows.filter((_, j) => j !== i);
      return predictValue(fitValueStep(sub, terms, useCat), row, step);
    });
    const loo = missFactor(rows.map((r) => r.lnCap), looPred);
    // Walk-forward: fit on the earlier-listed half, price the later half.
    const wfFit = fitValueStep(train, terms, useCat);
    const wf = missFactor(test.map((r) => r.lnCap), test.map((r) => predictValue(wfFit, r, step)));
    let stamp: string;
    if (stepDef.add === 'flat') stamp = 'baseline';
    else if (stepDef.add === 'control') stamp = 'must not help';
    else if (prev !== null && loo < prev.loo && wf < prev.wf) {
      stamp = 'kept';
      if (stepDef.add === 'cat') keptCat = true;
      else keptTerms.push(stepDef.add as ValueTerm);
    } else stamp = 'tested, not kept';
    ladder.push({ label: stepDef.label, test_a_label: 'leave-one-out', test_a: round2(loo), test_b_label: 'walk-forward', test_b: round2(wf), stamp });
    prev = { loo, wf };
  });
  return { ladder, kept: { terms: keptTerms, useCat: keptCat } };
}

// ---------------------------------------------------------------------------
// The odds model: whether a peer records a token, fitted on the snapshot's
// non-product protocols (the peers' record: 244 of 442 record one).
// ---------------------------------------------------------------------------

type OddsTerm = 'years' | 'lnTvl' | 'growth' | 'lnChains' | 'control';

interface OddsRow {
  p: SnapshotProtocol;
  y: number;
  years: number;
  lnTvl: number;
  growth: number;
  lnChains: number;
  control: number;
  cat: string;
}

interface OddsFit {
  beta: number[];
  terms: OddsTerm[];
  catOffsets: Map<string, number>;
  medianYears: number;
  base: number;
}

const ODDS_LADDER: { label: string; add: OddsTerm | 'base' | 'cat' }[] = [
  { label: 'base rate of peers', add: 'base' },
  { label: '+ age, years', add: 'years' },
  { label: '+ category effect', add: 'cat' },
  { label: '+ size curve, ln TVL', add: 'lnTvl' },
  { label: '+ 7-day TVL growth', add: 'growth' },
  { label: '+ chain count, ln', add: 'lnChains' },
  { label: '+ control (another row)', add: 'control' },
];

function oddsRows(snapshot: Snapshot): OddsRow[] {
  const peers = snapshot.protocols.filter((p) => !isProduct(p));
  const dated = peers.map((p) => ageDays(snapshot.as_of, p.listed_at)).filter((d): d is number => d !== null);
  const medYears = (dated.length ? median(dated) : 0) / 365.25;
  const sorted = [...peers].sort((a, b) => (a.slug < b.slug ? -1 : 1));
  return sorted.map((p, i) => {
    const days = ageDays(snapshot.as_of, p.listed_at);
    return {
      p,
      y: isPreToken(p) ? 0 : 1,
      years: days === null ? medYears : days / 365.25,
      lnTvl: Math.log(Math.max(1, p.tvl_usd)),
      growth: finite(p.change_7d, 0),
      lnChains: Math.log(Math.max(1, p.chains.length)),
      control: (() => { const d = ageDays(snapshot.as_of, sorted[(i + 1) % sorted.length]!.listed_at); return d === null ? medYears : d / 365.25; })(),
      cat: p.category ?? '',
    };
  });
}

function oddsDesign(row: OddsRow, terms: OddsTerm[]): number[] {
  const x = [1];
  for (const t of ['years', 'lnTvl', 'growth', 'lnChains', 'control'] as OddsTerm[]) {
    if (terms.includes(t)) x.push(row[t]);
  }
  return x;
}

function catOffsetsFor(rows: OddsRow[]): Map<string, number> {
  const base = mean(rows.map((r) => r.y));
  const byCat = new Map<string, { n: number; t: number }>();
  for (const r of rows) {
    const e = byCat.get(r.cat) ?? { n: 0, t: 0 };
    e.n += 1; e.t += r.y;
    byCat.set(r.cat, e);
  }
  const out = new Map<string, number>();
  for (const [cat, e] of byCat) {
    const rate = (e.t + 20 * base) / (e.n + 20);
    out.set(cat, logit(rate) - logit(base));
  }
  return out;
}

function fitOddsStep(rows: OddsRow[], terms: OddsTerm[], useCat: boolean): OddsFit {
  const offsets = useCat ? catOffsetsFor(rows) : new Map<string, number>();
  const off = rows.map((r) => offsets.get(r.cat) ?? 0);
  const beta = logisticFit(rows.map((r) => oddsDesign(r, terms)), rows.map((r) => r.y), off);
  return { beta, terms, catOffsets: offsets, medianYears: median(rows.map((r) => r.years)), base: mean(rows.map((r) => r.y)) };
}

function predictOdds(fit: OddsFit, row: OddsRow): number {
  const x = oddsDesign(row, fit.terms);
  let z = fit.catOffsets.get(row.cat) ?? 0;
  for (let i = 0; i < x.length; i++) z += x[i]! * fit.beta[i]!;
  return sigmoid(z);
}

const brier = (rows: OddsRow[], preds: number[]): number => mean(rows.map((r, i) => (r.y - preds[i]!) ** 2));

/** Run the odds ladder: ten-fold cross-validation and walk-forward Brier scores. */
function runOddsLadder(rows: OddsRow[]): { ladder: (TermResult & { acc: number })[]; kept: { terms: OddsTerm[]; useCat: boolean } } {
  const dated = rows.filter((r) => r.p.listed_at !== null).sort((a, b) => (a.p.listed_at! < b.p.listed_at! ? -1 : 1));
  const half = Math.floor(dated.length / 2);
  const train = dated.slice(0, half);
  const test = dated.slice(half);
  const ladder: (TermResult & { acc: number })[] = [];
  let terms: OddsTerm[] = [];
  let useCat = false;
  let prev: { cv: number; wf: number } | null = null;
  const keptTerms: OddsTerm[] = [];
  let keptCat = false;
  ODDS_LADDER.forEach((stepDef) => {
    if (stepDef.add === 'cat') useCat = true;
    else if (stepDef.add !== 'base') terms = [...terms, stepDef.add as OddsTerm];
    // Ten-fold: folds by position in slug order, one fit per fold, out-of-fold predictions.
    const oof = new Array(rows.length).fill(0);
    for (let f = 0; f < 10; f++) {
      const foldFit = fitOddsStep(rows.filter((_, j) => j % 10 !== f), terms, useCat);
      rows.forEach((row, i) => { if (i % 10 === f) oof[i] = predictOdds(foldFit, row); });
    }
    const cv = brier(rows, oof);
    const acc = mean(rows.map((r, i) => ((oof[i]! >= 0.5 ? 1 : 0) === r.y ? 1 : 0)));
    const wfFit = fitOddsStep(train, terms, useCat);
    const wf = brier(test, test.map((r) => predictOdds(wfFit, r)));
    let stamp: string;
    if (stepDef.add === 'base') stamp = 'baseline';
    else if (stepDef.add === 'control') stamp = 'must not help';
    else if (prev !== null && cv < prev.cv && wf < prev.wf) {
      stamp = 'kept';
      if (stepDef.add === 'cat') keptCat = true;
      else keptTerms.push(stepDef.add as OddsTerm);
    } else stamp = 'tested, not kept';
    ladder.push({ label: stepDef.label, test_a_label: 'ten-fold', test_a: round4(cv), test_b_label: 'walk-forward', test_b: round4(wf), stamp, acc: Math.round(acc * 100) });
    prev = { cv, wf };
  });
  return { ladder, kept: { terms: keptTerms, useCat: keptCat } };
}

// ---------------------------------------------------------------------------
// Farm economics: what one reader's plan is expected to make, costed.
// The same arithmetic runs in the dashboard when a reader moves the controls.
// ---------------------------------------------------------------------------

/** What one transaction costs on a chain, in dollars: the numeric twin of the ranges in the steps. */
function gasUsd(chain: string): number {
  switch (chain) {
    case 'Ethereum': return 3;
    case 'Solana': return 0.05;
    case 'Bitcoin': return 2;
    case 'BSC': return 0.3;
    case 'Avalanche': return 0.5;
    case 'Polygon': case 'Arbitrum': case 'Base': case 'Optimism': case 'zkSync Era':
    case 'Linea': case 'Scroll': case 'Mantle': case 'Blast': case 'Mode': case 'Zora':
      return 0.4;
    default: return 1;
  }
}

export interface Econ {
  deposit: number;
  drop: number;
  fees: number;
  net: number;
  perHour: number;
  hours: number;
  verdict: 'FARM' | 'MARGINAL' | 'SKIP';
}

/** One row's farm economics under a set of controls (the defaults are FARM's). */
export function farmEcon(tvl: number, impliedExact: number, gasTx: number, chainCount: number, c = FARM): Econ {
  const deposit = Math.min(c.dep_max, Math.max(c.dep_min, Math.round(c.plan_pct * tvl)));
  const pool = c.drop_share * impliedExact;
  const share = deposit / (deposit + c.participation * tvl);
  const drop = pool * share;
  const weeklyTxs = 1 + 0.25 * Math.min(3, Math.max(0, chainCount - 1));
  const fees = (3 + c.horizon_wk * weeklyTxs) * gasTx + c.swap_pct * deposit + deposit * c.funding_apr * (c.horizon_wk / 52);
  const hours = 1 + c.horizon_wk * 0.5 + 0.75; // setup, half an hour a week of upkeep, close-out
  const net = drop - fees;
  const perHour = net / hours;
  const verdict = net <= 0 ? 'SKIP' : net >= c.bar_net && perHour >= c.bar_hour ? 'FARM' : 'MARGINAL';
  return { deposit, drop: round2(drop), fees: round2(fees), net: round2(net), perHour: round2(perHour), hours: round2(hours), verdict };
}

// ---------------------------------------------------------------------------
// Farm plans. Each plan is derived from the protocol's own record: its
// category family decides the actions, its first chain decides the gas costs,
// its TVL decides the position size, and its age decides the holding window.
// Every step states what to do, what it costs and how long it takes.
// ---------------------------------------------------------------------------

/** The chain a plan is written for: the protocol's first chain, or a neutral phrase. */
function mainChain(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** What one transaction costs on a chain, in plain ranges a farmer can budget with. */
function gasFor(chain: string): string {
  switch (chain) {
    case 'Ethereum': return '$8 to $15 of gas per transaction';
    case 'Solana': return 'under $0.10 of fees per transaction';
    case 'Bitcoin': return '$1 to $4 of fees per transaction';
    case 'BSC': return 'about $0.30 of gas per transaction';
    case 'Avalanche': return 'about $0.50 of gas per transaction';
    case 'Polygon': case 'Arbitrum': case 'Base': case 'Optimism': case 'zkSync Era':
    case 'Linea': case 'Scroll': case 'Mantle': case 'Blast': case 'Mode': case 'Zora':
      return '$0.20 to $2 of gas per transaction';
    default: return '$1 to $5 of gas per transaction';
  }
}

/** A weekly cadence's gas budget on a chain, from its per-transaction range. */
function weeklyGasFor(chain: string): string {
  switch (chain) {
    case 'Ethereum': return 'about $10 a week of gas';
    case 'Solana': return 'under $1 a week of fees';
    case 'BSC': case 'Avalanche': case 'Polygon': case 'Arbitrum': case 'Base': case 'Optimism':
      return 'about $2 a week of gas';
    default: return 'about $4 a week of gas';
  }
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 45;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The plan family a category belongs to; the family decides the plan's actions. */
function familyOf(category: string | null): string {
  const c = (category ?? '').toLowerCase();
  if (c.includes('cdp')) return 'cdp';
  if (c.includes('lend')) return 'lending';
  if (c.includes('dex')) return 'dex';
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('option')) return 'perps';
  if (c.includes('curator') || c.includes('allocator')) return 'curator';
  if (c.includes('staking') || c.includes('restak')) return 'staking';
  if (c.includes('bridge')) return 'bridge';
  if (c.includes('rwa')) return 'rwa';
  if (c.includes('stable') || c.includes('algo')) return 'stable';
  if (c.includes('prediction')) return 'prediction';
  if (c.includes('chain')) return 'chain';
  if (c.includes('basis')) return 'basis';
  if (c.includes('yield') || c.includes('farm') || c.includes('liquidity')) return 'yield';
  return 'generic';
}

/** The family's core position: the one action that makes a wallet count as a user. */
function coreAction(family: string, p: SnapshotProtocol, capital: number, chain: string): string {
  const name = p.name;
  switch (family) {
    case 'lending': return `Supply $${capital} of USDC to ${name} on ${chain}, then borrow about 40% of it back and re-supply the borrow once, so the wallet both lends and borrows.`;
    case 'cdp': return `Deposit $${capital} of collateral into a ${name} vault on ${chain} and mint about 40% of its value in the protocol's stablecoin, keeping the health factor above 2.`;
    case 'dex': return `Add $${capital} of liquidity to ${name}'s busiest stable or blue-chip pool on ${chain}, split evenly between the pair's two assets.`;
    case 'perps': return `Deposit $${capital} of USDC as margin on ${name} and open one small hedged position, half long and half short across two markets, so the account trades without betting on direction.`;
    case 'curator': return `Deposit $${capital} into the largest ${name} vault on ${chain} and leave the shares untouched, so the wallet holds a curator-managed position.`;
    case 'staking': return `Stake $${capital} of the chain's native asset through ${name} and keep the liquid receipt token in the same wallet.`;
    case 'bridge': return `Bridge $${capital} of USDC from Ethereum to ${chain} through ${name}, then make one swap with the bridged funds in the destination app.`;
    case 'rwa': return `Mint $${capital} of ${name}'s yield-bearing asset on ${chain} and hold it, so the wallet earns the underlying real-world yield.`;
    case 'stable': return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain} and hold it in the wallet, unstaked, for the full holding window.`;
    case 'prediction': return `Fund the account with $${capital} and take one position in ${name}'s most liquid market, sized under 10% of the market's volume.`;
    case 'chain': return `Bridge $${capital} of USDC to ${chain} and use two native apps in its ecosystem, one swap and one deposit, so the wallet is a real chain user.`;
    case 'basis': return `Deposit $${capital} of USDC into ${name}'s delta-neutral vault on ${chain} and keep the shares for the holding window.`;
    case 'yield': return `Deposit $${capital} into ${name}'s main vault on ${chain} and keep the vault shares in the wallet.`;
    default: return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open for the holding window.`;
  }
}

/** The family's weekly cadence: the repeat action that keeps a wallet active across snapshots. */
function cadenceAction(family: string, p: SnapshotProtocol, chain: string): string {
  const name = p.name;
  switch (family) {
    case 'lending': return `Once a week, repay a slice of the borrow and borrow it again on ${name}, and vote in any governance poll the protocol opens.`;
    case 'cdp': return `Once a week, add or release a small amount of collateral on ${name} so the vault is rebalanced in more than one snapshot.`;
    case 'dex': return `Make one swap a week through ${name} on ${chain}, rotating between the pools the wallet already uses, and claim any fees weekly.`;
    case 'perps': return `Trade one small position a week on ${name}, keeping the total weekly volume near the margin deposit, and never chase losses.`;
    case 'curator': return `Once a week, check the ${name} vault's allocation page and move 10% of the position if the curator opens a new vault.`;
    case 'staking': return `Claim and re-stake the rewards on ${name} once a week, so the receipt balance grows in more than one snapshot.`;
    case 'bridge': return `Bridge a small amount back or onward through ${name} once a week, alternating direction, and use the destination app each time.`;
    case 'rwa': return `Once a week, check ${name}'s attestation or reserve page and add a small top-up if the yield is paid on-chain.`;
    case 'stable': return `Once a week, make one transfer or payment with the stable asset from ${name}, so the wallet shows real circulation, not just a mint.`;
    case 'prediction': return `Take one new market position a week on ${name}, settling or closing the previous one first.`;
    case 'chain': return `Use one ${chain} ecosystem app a week, rotating between a swap, a lend and a bridge, so the wallet's activity is varied.`;
    case 'basis': return `Once a week, check ${name}'s funding and basis page and top up or trim the position by 10% to stay near the starting size.`;
    case 'yield': return `Harvest and re-deposit the yield on ${name} once a week, so the position compounds across snapshots.`;
    default: return `Make one qualifying action a week on ${name}, such as a deposit, a withdrawal of a slice, or a vote.`;
  }
}

/** A step as one string: the action, then its cost and its time, inside the gate's 20..600 chars. */
function stepText(text: string, cost: string, time: string): string {
  let s = `${text} Cost: ${cost}. Time: ${time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.trim().length < 20) s = `${s} Hold the position and check the protocol's own page before acting again.`;
  return s;
}

const usd0 = (n: number): string => `$${Math.round(n).toLocaleString('en-US')}`;

/**
 * A protocol's farm plan: seven steps, each an action with a cost and a time, derived from the
 * protocol's category, chains, TVL and age, closing with the plan's own costed verdict.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null, econ: Econ): string[] {
  const chain = mainChain(p);
  const family = familyOf(p.category);
  const capital = econ.deposit;
  const hold = holdDaysFor(age);
  const gas = gasFor(chain);
  const weekly = weeklyGasFor(chain);
  const secondChain = p.chains.length > 1 ? p.chains[1]! : null;
  return [
    stepText(
      `Open a fresh wallet for ${p.name} alone, fund it from an exchange withdrawal rather than from your main wallet, and keep its seed phrase on paper, offline.`,
      gas,
      '10 minutes',
    ),
    stepText(
      `Read ${p.name}'s own docs and points or rewards page first, and note which actions it says count, before you send a single transaction.`,
      'nothing',
      '25 minutes',
    ),
    stepText(coreAction(family, p, capital, chain), `$${capital} of capital and ${gas}`, 'about an hour to set up'),
    stepText(
      secondChain === null ? cadenceAction(family, p, chain) : `${cadenceAction(family, p, chain)} In week two, repeat the core position on ${secondChain} from the same wallet if the protocol counts multi-chain activity.`,
      weekly,
      '30 minutes a week',
    ),
    stepText(
      `Hold the position for at least ${hold} days, so the activity appears in more than one weekly snapshot of the protocol's usage.`,
      `the $${capital} stays in the position and earns its normal yield`,
      `${hold} days`,
    ),
    stepText(
      `Once a month, open ${p.name}'s official points or rewards page from the link in its docs, never from a search ad or a direct message, and check the wallet's standing.`,
      'nothing, and never pay anyone to check or to claim',
      '10 minutes a month',
    ),
    stepText(
      `The board's arithmetic for this plan: an expected drop of ${usd0(econ.drop)} against ${usd0(econ.fees)} of fees and charges over ${FARM.horizon_wk} weeks leaves ${usd0(econ.net)} net, about $${econ.perHour.toFixed(2)} an hour, so the verdict is ${econ.verdict}. Re-run it with your own deposit before acting.`,
      gas,
      '20 minutes',
    ),
  ];
}

// ---------------------------------------------------------------------------
// The board and the dashboard's data, assembled from the fitted models.
// ---------------------------------------------------------------------------

/** One row of board.json: a ranked pre-token protocol with its fitted values and farm plan. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  watchlist: boolean;
  age_days: number | null;
  implied_value_usd: number;
  model: {
    value_if_usd: number;
    odds: number;
    p25_usd: number;
    p75_usd: number;
    rank_lo: number;
    rank_hi: number;
    deposit_usd: number;
    drop_usd: number;
    fees_usd: number;
    net_usd: number;
    per_hour: number;
    verdict: string;
  };
  farm_steps: string[];
}

/** The dashboard's view of one board row. */
export interface RadarRow {
  rank: number;
  rank_lo: number;
  rank_hi: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  age_days: number | null;
  watchlist: boolean;
  tier: 'watchlist' | 'early' | 'off-list';
  odds: number;
  value_if_usd: number;
  implied_value_usd: number;
  p25_usd: number;
  p75_usd: number;
  vif25_usd: number;
  vif75_usd: number;
  deposit_usd: number;
  drop_usd: number;
  fees_usd: number;
  net_usd: number;
  per_hour: number;
  verdict: string;
  gas_tx: number;
  farm_steps: string[];
}

/** A live-token protocol: it already trades, so the board shows the market's own value. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** Everything the dashboard renders. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  formula_line: string;
  kpi: {
    wf_miss: number; flat_miss: number;
    honesty50: number; honesty80: number;
    brier: number; base_brier: number; wf_brier: number; called_right: number;
    terms_value: string; terms_odds: string;
    farm_count: number; marginal_count: number; skip_count: number;
    watchlist_size: number; board_size: number;
  };
  accounting: { key: string; label: string; count: number; color: string }[];
  accounting_total: number;
  integrity: { checksum: string; total_implied_usd: number; total_tvl_usd: number };
  evidence: {
    value_terms: TermResult[];
    odds_terms: (TermResult & { acc: number })[];
    honesty: { label: string; stated: string; loo: number; wf: number }[];
    value_coefs: { label: string; est: number; se: number }[];
    odds_coefs: { label: string; est: number; se: number }[];
    reading: string;
    fit_n: number;
    peers_n: number;
    peers_token_n: number;
  };
  farm_params: typeof FARM;
  model: {
    value: { use_size: boolean; flat: number; beta: number[]; terms: ValueTerm[]; cat_effects: Record<string, number>; median_years: number };
    odds: { beta: number[]; terms: OddsTerm[]; cat_offsets: Record<string, number>; median_years: number };
    conformal: { q10: number; q25: number; q75: number; q90: number; cal_n: number };
  };
  watchlist_size: number;
  board_size: number;
  early_size: number;
  set_aside_size: number;
  live_size: number;
  rows: RadarRow[];
  live: LiveRow[];
}

const LIVE_ROWS = 36;

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1))
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** Features of any protocol under each model, with the fit's own median age for unrecorded dates. */
function boardFeatures(p: SnapshotProtocol, snapshot: Snapshot, vFit: ValueFit, oFit: OddsFit): { v: ValueRow; o: OddsRow } {
  const days = ageDays(snapshot.as_of, p.listed_at);
  const base = {
    p,
    lnTvl: Math.log(Math.max(1, p.tvl_usd)),
    growth: finite(p.change_7d, 0),
    lnChains: Math.log(Math.max(1, p.chains.length)),
    cat: p.category ?? '',
  };
  return {
    v: { ...base, years: days === null ? vFit.medianYears : days / 365.25, control: finite(p.change_7d, 0), lnCap: 0 },
    o: { ...base, y: 0, years: days === null ? oFit.medianYears : days / 365.25, control: days === null ? oFit.medianYears : days / 365.25 },
  };
}

/** Everything, fitted and assembled: the board for board.json and the data for the dashboard. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const vRows = valueRows(snapshot);
  const oRows = oddsRows(snapshot);
  const vLadder = runValueLadder(vRows);
  const oLadder = runOddsLadder(oRows);

  const sizeKept = vLadder.kept.terms.includes('lnTvl');
  const vTerms = vLadder.kept.terms.filter((t) => t !== 'lnTvl');
  const vCat = sizeKept && vLadder.kept.useCat;
  const vFit = fitValueStep(vRows, vTerms, vCat);
  const oFit = fitOddsStep(oRows, oLadder.kept.terms, oLadder.kept.useCat);
  const vStep = sizeKept ? 1 : 0;
  const vPredict = (fit: ValueFit, row: ValueRow): number => predictValue(fit, row, vStep);
  const finalValueTerms: ValueTerm[] = sizeKept ? ['lnTvl', ...vTerms] : [];

  // Final-model validation, recomputed for the exact procedure that ships.
  const looPred = vRows.map((row, i) => vPredict(fitValueStep(vRows.filter((_, j) => j !== i), vTerms, vCat), row));
  const looErr = vRows.map((r, i) => r.lnCap - looPred[i]!);
  const looMiss = missFactor(vRows.map((r) => r.lnCap), looPred);
  const residSd = sd(looErr);
  const datedV = vRows.filter((r) => r.p.listed_at !== null).sort((a, b) => (a.p.listed_at! < b.p.listed_at! ? -1 : 1));
  const vHalf = Math.floor(datedV.length / 2);
  const wfFit = fitValueStep(datedV.slice(0, vHalf), vTerms, vCat);
  const wfTest = datedV.slice(vHalf);
  const wfErr = wfTest.map((r) => r.lnCap - vPredict(wfFit, r));
  const wfMiss = missFactor(wfTest.map((r) => r.lnCap), wfTest.map((r) => vPredict(wfFit, r)));
  const wfResidSd = sd(datedV.slice(0, vHalf).map((r) => r.lnCap - vPredict(wfFit, r)));
  const cover = (errs: number[], s: number, z: number): number => Math.round(100 * mean(errs.map((e) => (Math.abs(e) <= z * s ? 1 : 0))));
  // Conformal calibration of the printed ranges. The widths come from the
  // empirical quantiles of the leave-one-out residuals across all traded
  // tokens — each residual is out-of-sample for its own token (its model never
  // saw it), so this is cross-conformal, not a fit to the errors it measures.
  // The normal bands the previous version used covered 85% leave-one-out but
  // only 71% walk-forward at the stated 80%: the errors are not normal, and
  // the earlier-listed half alone is too easy to calibrate on (it gave 63%).
  const calSorted = [...looErr].sort((a, b) => a - b);
  // Finite-sample conformal quantile: the ceil(level * (n + 1))-th smallest residual.
  const confQ = (level: number): number => {
    const k = Math.min(calSorted.length, Math.max(1, Math.ceil(level * (calSorted.length + 1))));
    return calSorted[k - 1]!;
  };
  const q10 = confQ(0.10);
  const q25 = confQ(0.25);
  const q75 = confQ(0.75);
  const q90 = confQ(0.90);
  const inBand = (errs: number[], lo: number, hi: number): number => Math.round(100 * mean(errs.map((e) => (e >= lo && e <= hi ? 1 : 0))));
  const honesty = [
    { label: 'within ×3 of the model', stated: '—', loo: Math.round(100 * mean(looErr.map((e) => (Math.abs(e) <= Math.log(3) ? 1 : 0)))), wf: Math.round(100 * mean(wfErr.map((e) => (Math.abs(e) <= Math.log(3) ? 1 : 0)))) },
    { label: 'inside P25–P75', stated: '50%', loo: inBand(looErr, q25, q75), wf: inBand(wfErr, q25, q75) },
    { label: 'inside P10–P90', stated: '80%', loo: inBand(looErr, q10, q90), wf: inBand(wfErr, q10, q90) },
  ];
  // Final odds validation: ten-fold out-of-fold Brier for the shipped procedure.
  const oof = new Array(oRows.length).fill(0);
  for (let f = 0; f < 10; f++) {
    const foldFit = fitOddsStep(oRows.filter((_, j) => j % 10 !== f), oLadder.kept.terms, oLadder.kept.useCat);
    oRows.forEach((row, i) => { if (i % 10 === f) oof[i] = predictOdds(foldFit, row); });
  }
  const oofBrier = brier(oRows, oof);
  const oofAcc = Math.round(100 * mean(oRows.map((r, i) => ((oof[i]! >= 0.5 ? 1 : 0) === r.y ? 1 : 0))));
  const datedO = oRows.filter((r) => r.p.listed_at !== null).sort((a, b) => (a.p.listed_at! < b.p.listed_at! ? -1 : 1));
  const oHalf = Math.floor(datedO.length / 2);
  const wfOddsFit = fitOddsStep(datedO.slice(0, oHalf), oLadder.kept.terms, oLadder.kept.useCat);
  const wfBrier = brier(datedO.slice(oHalf), datedO.slice(oHalf).map((r) => predictOdds(wfOddsFit, r)));

  // The board's candidates: the watchlist plus every other launch candidate.
  const watch = new Set(snapshot.watchlist);
  const candidates = snapshot.protocols.filter((p) => watch.has(p.slug) || isLaunchCandidate(p));
  const feats = new Map(candidates.map((p) => [p.slug, boardFeatures(p, snapshot, vFit, oFit)]));
  const score = (vf: ValueFit, of: OddsFit, p: SnapshotProtocol): { vif: number; odds: number; implied: number } => {
    const f = feats.get(p.slug)!;
    const vif = Math.exp(vPredict(vf, f.v));
    const odds = Math.min(0.99, Math.max(0.01, predictOdds(of, f.o)));
    return { vif, odds, implied: Math.max(1, Math.round(odds * vif)) };
  };
  const scored = candidates.map((p) => ({ p, s: score(vFit, oFit, p) }));

  // Bootstrap refits of both final models: rank ranges, value ranges, coefficient errors.
  const rand = rng(20261126);
  const resample = <T,>(rows: T[]): T[] => rows.map(() => rows[Math.floor(rand() * rows.length)]!);
  const bootImplied = new Map<string, number[]>();
  const bootVif = new Map<string, number[]>();
  const bootRanks = new Map<string, number[]>();
  const oddsBetas: number[][] = [];
  const BOOT = 40;
  for (let b = 0; b < BOOT; b++) {
    const bv = fitValueStep(resample(vRows), vTerms, vCat);
    const bo = fitOddsStep(resample(oRows), oLadder.kept.terms, oLadder.kept.useCat);
    oddsBetas.push(bo.beta);
    const refit = candidates.map((p) => ({ slug: p.slug, s: score(bv, bo, p) }));
    refit.sort((a, z) => z.s.implied - a.s.implied || (a.slug < z.slug ? -1 : 1));
    refit.forEach((r, i) => {
      (bootRanks.get(r.slug) ?? bootRanks.set(r.slug, []).get(r.slug)!).push(i + 1);
      (bootImplied.get(r.slug) ?? bootImplied.set(r.slug, []).get(r.slug)!).push(r.s.implied);
      (bootVif.get(r.slug) ?? bootVif.set(r.slug, []).get(r.slug)!).push(r.s.vif);
    });
  }
  // Coefficient standard errors: 200 cheap value refits, the odds refits above plus 60 more.
  const valueBetas: number[][] = [];
  for (let b = 0; b < 200; b++) valueBetas.push(fitValueStep(resample(vRows), vTerms, vCat).beta);
  for (let b = 0; b < 60; b++) oddsBetas.push(fitOddsStep(resample(oRows), oLadder.kept.terms, oLadder.kept.useCat).beta);
  // Beta order follows the design builders: value = [1, lnTvl, ...kept terms in ladder order],
  // odds = [1, ...kept terms in the fixed design order]. Labels are aligned with those designs.
  const valueLabels = ['intercept', 'ln TVL', ...vTerms.map((t) => (t === 'growth' ? '7-day growth' : t === 'years' ? 'years listed' : t === 'lnChains' ? 'ln chains' : t))];
  const oddsDesignOrder = (['years', 'lnTvl', 'growth', 'lnChains', 'control'] as OddsTerm[]).filter((t) => oLadder.kept.terms.includes(t));
  const oddsLabels = ['intercept', ...oddsDesignOrder.map((t) => (t === 'years' ? 'years listed' : t === 'lnTvl' ? 'ln TVL' : t === 'growth' ? '7-day growth' : 'ln chains'))];
  const valueCoefs = valueLabels.map((label, i) => ({ label, est: round4(vFit.beta[i] ?? 0), se: round4(sd(valueBetas.map((bb) => bb[i] ?? 0))) }));
  const oddsCoefs = oddsLabels.map((label, i) => ({ label, est: round4(oFit.beta[i] ?? 0), se: round4(sd(oddsBetas.map((bb) => bb[i] ?? 0))) }));

  // Ranks, economics, rows.
  scored.sort((a, b) => b.s.implied - a.s.implied || (a.p.slug < b.p.slug ? -1 : 1));
  const board: BoardRow[] = [];
  const radarRows: RadarRow[] = [];
  scored.forEach(({ p, s }, i) => {
    const age = ageDays(snapshot.as_of, p.listed_at);
    const gasTx = gasUsd(mainChain(p));
    const econ = farmEcon(p.tvl_usd, s.odds * s.vif, gasTx, p.chains.length);
    const ranks = [...(bootRanks.get(p.slug) ?? [i + 1])].sort((a, b) => a - b);
    const imps = [...(bootImplied.get(p.slug) ?? [s.implied])].sort((a, b) => a - b);
    const vifs = [...(bootVif.get(p.slug) ?? [s.vif])].sort((a, b) => a - b);
    const model = {
      value_if_usd: Math.round(s.vif),
      odds: round4(s.odds),
      // Printed range: the bootstrap spread (parameter uncertainty) widened by
      // the split-conformal residual quantiles (outcome noise), so the range a
      // reader sees is the range the honesty panel actually measures.
      p25_usd: Math.round(quantile(imps, 0.25) * Math.exp(q25)),
      p75_usd: Math.round(quantile(imps, 0.75) * Math.exp(q75)),
      rank_lo: Math.round(quantile(ranks, 0.25)),
      rank_hi: Math.round(quantile(ranks, 0.75)),
      deposit_usd: econ.deposit,
      drop_usd: econ.drop,
      fees_usd: econ.fees,
      net_usd: econ.net,
      per_hour: econ.perHour,
      verdict: econ.verdict,
    };
    board.push({
      rank: i + 1, slug: p.slug, name: p.name, category: p.category, chains: p.chains,
      tvl_usd: p.tvl_usd, change_7d: p.change_7d, mcap_usd: p.mcap_usd, listed_at: p.listed_at,
      gecko_id: p.gecko_id, symbol: p.symbol, token_status: 'pre-token', watchlist: watch.has(p.slug),
      age_days: age, implied_value_usd: s.implied, model, farm_steps: farmSteps(p, age, econ),
    });
    radarRows.push({
      rank: i + 1, rank_lo: model.rank_lo, rank_hi: model.rank_hi, slug: p.slug, name: p.name,
      category: p.category, chains: p.chains, tvl_usd: p.tvl_usd, change_7d: p.change_7d,
      age_days: age, watchlist: watch.has(p.slug),
      tier: watch.has(p.slug) ? 'watchlist' : p.tvl_usd >= snapshot.floor_usd ? 'off-list' : 'early',
      odds: model.odds, value_if_usd: model.value_if_usd, implied_value_usd: s.implied,
      p25_usd: model.p25_usd, p75_usd: model.p75_usd,
      vif25_usd: Math.round(quantile(vifs, 0.25)), vif75_usd: Math.round(quantile(vifs, 0.75)),
      deposit_usd: econ.deposit, drop_usd: econ.drop, fees_usd: econ.fees, net_usd: econ.net,
      per_hour: econ.perHour, verdict: econ.verdict, gas_tx: gasTx, farm_steps: board[i]!.farm_steps,
    });
  });

  // The protocol ledger: every one of the snapshot's protocols in exactly one group.
  const boardSlugs = new Set(board.map((r) => r.slug));
  const groups = new Map<string, number>();
  const bump = (k: string): void => { groups.set(k, (groups.get(k) ?? 0) + 1); };
  for (const p of snapshot.protocols) {
    if (boardSlugs.has(p.slug)) bump(watch.has(p.slug) ? 'ranked_watchlist' : p.tvl_usd >= snapshot.floor_usd ? 'ranked_offlist' : 'ranked_early');
    else if (!isPreToken(p)) bump(!isProduct(p) && p.mcap_usd !== null && p.mcap_usd > 0 ? 'token_priced' : 'token_unpriced');
    else bump(`aside_${setAsideReason(p)}`);
  }
  const accountingSpec: { key: string; label: string; color: string }[] = [
    { key: 'ranked_watchlist', label: 'Ranked · watchlist', color: '#2fbf71' },
    { key: 'ranked_early', label: 'Ranked · early, below the floor', color: '#7ee2a8' },
    { key: 'ranked_offlist', label: 'Ranked · off-list, parent recorded', color: '#f5c542' },
    { key: 'token_priced', label: 'Token trades · priced comp', color: '#4f8ff7' },
    { key: 'token_unpriced', label: 'Token recorded · no usable cap', color: '#5b6b82' },
    { key: 'aside_bridge', label: 'Out · bridge', color: '#8a5cf6' },
    { key: 'aside_staking', label: 'Out · liquid staking', color: '#c65df6' },
    { key: 'aside_exchange', label: 'Out · exchange', color: '#f66d5d' },
    { key: 'aside_versioned', label: 'Out · versioned or wrapped', color: '#f6925d' },
  ];
  const accounting = accountingSpec.map((g) => ({ ...g, count: groups.get(g.key) ?? 0 })).filter((g) => g.count > 0);
  const accountingTotal = accounting.reduce((s, g) => s + g.count, 0);

  const totalImplied = board.reduce((s, r) => s + r.implied_value_usd, 0);
  const totalTvl = board.reduce((s, r) => s + r.tvl_usd, 0);
  const checksum = fnv1a(board.map((r) => `${r.slug}:${r.rank}:${r.implied_value_usd}`).join('|'));

  const joinList = (xs: string[]): string => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
  const droppedValue = vLadder.ladder.filter((t) => t.stamp === 'tested, not kept').map((t) => t.label.replace(/^\+\s*/, ''));
  const keptOddsLabels = oLadder.ladder.filter((t) => t.stamp === 'kept').map((t) => t.label.replace(/^\+\s*/, ''));
  const peersToken = oRows.reduce((s, r) => s + r.y, 0);
  const reading =
    `Reading it: ${droppedValue.length ? `${joinList(droppedValue)} fail to price a token better held-out, so the value model leaves them out; ` : ''}` +
    `${keptOddsLabels.length ? `${joinList(keptOddsLabels)} help tell which peers record a token, so they enter through the odds. ` : ''}` +
    `The odds are the peers' record (${peersToken} of ${oRows.length} record a token) — not a forecast: this page never says a token will launch. ` +
    `The printed ranges are conformal: their widths are the empirical quantiles of leave-one-out errors across all traded tokens, so the honesty panel measures the ranges as printed, not a normal approximation.`;

  const live = liveRows(snapshot);
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    formula_line:
      `Implied value = fitted value if it launches × fitted token odds. ` +
      `ln cap = ${round2(vFit.beta[0] ?? 0)} + ${round2(vFit.beta[1] ?? 0)} × ln TVL` +
      vTerms.map((t, i) => { const c = round2(vFit.beta[2 + i] ?? 0); return ` ${c < 0 ? '−' : '+'} ${Math.abs(c)} × ${t === 'growth' ? '7-day growth' : t === 'years' ? 'years listed' : 'ln chains'}`; }).join('') +
      `${vCat ? ' + category effect' : ''} over ${vRows.length} traded tokens; ` +
      `odds from a logistic fit on ${oRows.length} peers. Every coefficient is fitted here and tested held-out below.`,
    kpi: {
      wf_miss: round2(wfMiss), flat_miss: round2(vLadder.ladder[0]!.test_b),
      honesty50: honesty[1]!.wf, honesty80: honesty[2]!.wf,
      brier: round4(oofBrier), base_brier: round4(oLadder.ladder[0]!.test_a), wf_brier: round4(wfBrier), called_right: oofAcc,
      terms_value: `${vLadder.ladder.filter((t) => t.stamp === 'kept').length} of ${vLadder.ladder.length - 1}`,
      terms_odds: `${oLadder.ladder.filter((t) => t.stamp === 'kept').length} of ${oLadder.ladder.length - 1}`,
      farm_count: radarRows.filter((r) => r.verdict === 'FARM').length,
      marginal_count: radarRows.filter((r) => r.verdict === 'MARGINAL').length,
      skip_count: radarRows.filter((r) => r.verdict === 'SKIP').length,
      watchlist_size: snapshot.watchlist.length,
      board_size: board.length,
    },
    accounting,
    accounting_total: accountingTotal,
    integrity: { checksum, total_implied_usd: totalImplied, total_tvl_usd: totalTvl },
    evidence: {
      value_terms: vLadder.ladder,
      odds_terms: oLadder.ladder,
      honesty,
      value_coefs: valueCoefs,
      odds_coefs: oddsCoefs,
      reading,
      fit_n: vRows.length,
      peers_n: oRows.length,
      peers_token_n: peersToken,
    },
    farm_params: FARM,
    model: {
      value: {
        use_size: sizeKept, flat: vFit.flat, beta: vFit.beta, terms: finalValueTerms,
        cat_effects: Object.fromEntries(vFit.catEffects), median_years: vFit.medianYears,
      },
      odds: {
        beta: oFit.beta, terms: oLadder.kept.terms,
        cat_offsets: Object.fromEntries(oFit.catOffsets), median_years: oFit.medianYears,
      },
      conformal: { q10: round4(q10), q25: round4(q25), q75: round4(q75), q90: round4(q90), cal_n: looErr.length },
    },
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: radarRows.filter((r) => r.tier !== 'watchlist').length,
    set_aside_size: snapshot.protocols.filter((p) => isPreToken(p) && !boardSlugs.has(p.slug)).length,
    live_size: live.length,
    rows: radarRows,
    live,
  };
  return { board, radar };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, values, farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `the board holds ${board.length} rows, outside 100..4000`;
  const slugs = new Set(board.map((r) => r.slug));
  if (slugs.size !== board.length) return 'a slug appears on the board twice';
  const known = new Set(snapshot.protocols.map((p) => p.slug));
  for (const r of board) if (!known.has(r.slug)) return `${r.slug} is not one of the snapshot's protocols`;
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) {
    if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  }
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 100_000_000_000_000) {
      return `${r.slug} has implied value ${r.implied_value_usd}`;
    }
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `${r.slug} has a farm step of ${t.length} characters`;
    }
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not an object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}
