// Token Radar's model: one sealed snapshot in, one ranked board of pre-token protocols out.
//
// The board ranks protocols that record no token yet. Every slug on the snapshot's watchlist is on
// the board (the floor, never the ceiling). Beyond it, the early radar ranks every other pre-token
// protocol that passes the same hygiene the house applied to its watchlist: an exchange product, a
// versioned pool of another protocol, or a wrapped or staked wrapper of a token that already trades
// is a product, not a launch candidate, and is set aside rather than ranked.
//
// Implied value is one formula over the snapshot's own figures, the same for every row:
//
//   multiple(category) = the median market-cap / TVL of the snapshot's live protocols in that
//                        category, shrunk toward the snapshot's global median by the peer count
//                        and clamped: what the market already pays per dollar of TVL for this
//                        kind of protocol, measured on this snapshot, never a hand-set number
//   growthMult         = 1 + clamp(change_7d, -60, 120) / 100 x 0.5
//   maturityMult       = 0.6 + min(age_days, 1095) / 1095 x 0.4, where age is the time the
//                        protocol has run with no token; an unrecorded age uses the median age
//                        of the snapshot's pre-token protocols
//   implied            = max(1, round(tvl_usd x multiple x growthMult x maturityMult))
//
// No protocol name is ever special-cased: the same code scores every row, and the board carries
// each row's multiple, peer count and multipliers so a reader can recompute any row by hand.

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

/** The model's fixed constants. The multiples are NOT here: they are measured from the snapshot. */
export const MODEL = {
  growth_weight: 0.5,
  growth_floor: -60,
  growth_cap: 120,
  maturity_floor: 0.6,
  maturity_range: 0.4,
  maturity_days: 1095,
  peer_shrinkage: 6,
  multiple_floor: 0.03,
  multiple_cap: 2.0,
};

/** The model's version label: the dashboard names it and board.json carries it. */
export const MODEL_VERSION = 'peer-multiple-1';

/** How many live-token protocols the dashboard's Live token view carries, by market cap. */
export const LIVE_ROWS = 36;

/** One row of board.json: a ranked pre-token protocol with its model inputs and farm plan. */
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
    category_multiple: number;
    peer_count: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** The dashboard's view of one board row: the row itself, farm plan included. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  watchlist: boolean;
  implied_value_usd: number;
  category_multiple: number;
  peer_count: number;
  growth_multiplier: number;
  maturity_multiplier: number;
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

/** Everything the dashboard renders, and the measured constants it states. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: typeof MODEL;
  model_version: string;
  global_median_multiple: number;
  unknown_age_days: number;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  set_aside_size: number;
  rows: RadarRow[];
  live: LiveRow[];
}

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

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

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

/**
 * Whether a pre-token protocol beyond the watchlist is a launch candidate rather than a product:
 * the watchlist's own hygiene, applied to every row of the board.
 */
export function isLaunchCandidate(p: SnapshotProtocol): boolean {
  if (!isPreToken(p)) return false;
  if (PRODUCT_CATEGORIES.has(p.category ?? '')) return false;
  if (VERSIONED.test(p.name)) return false;
  if (WRAPPER_WORD.test(p.name)) return false;
  if (EXCHANGE_PREFIXES.some((x) => p.name === x || p.name.startsWith(`${x} `))) return false;
  return true;
}

/** The measured multiples: one per category, plus the global median they shrink toward. */
export interface PeerMultiples {
  global_median: number;
  by_category: Map<string, { multiple: number; peers: number }>;
}

/**
 * What the market pays per dollar of TVL, measured on this snapshot: for each category, the
 * median market-cap / TVL of its live protocols, pulled toward the global median in proportion
 * to how few peers the category has, then clamped to a sane band.
 */
export function peerMultiples(snapshot: Snapshot): PeerMultiples {
  const ratiosByCategory = new Map<string, number[]>();
  const all: number[] = [];
  for (const p of snapshot.protocols) {
    if (isPreToken(p) || p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0) continue;
    const ratio = p.mcap_usd / p.tvl_usd;
    all.push(ratio);
    const key = p.category ?? '';
    const list = ratiosByCategory.get(key);
    if (list === undefined) ratiosByCategory.set(key, [ratio]);
    else list.push(ratio);
  }
  const globalMedian = median(all);
  const byCategory = new Map<string, { multiple: number; peers: number }>();
  for (const [category, ratios] of ratiosByCategory) {
    const n = ratios.length;
    const shrunk = (n * median(ratios) + MODEL.peer_shrinkage * globalMedian) / (n + MODEL.peer_shrinkage);
    byCategory.set(category, {
      multiple: Math.min(MODEL.multiple_cap, Math.max(MODEL.multiple_floor, shrunk)),
      peers: n,
    });
  }
  return { global_median: globalMedian, by_category: byCategory };
}

/** The fallback age for a protocol whose listing day is unrecorded: the snapshot's median age. */
export function medianPreTokenAge(snapshot: Snapshot): number {
  const ages: number[] = [];
  for (const p of snapshot.protocols) {
    if (!isPreToken(p)) continue;
    const age = ageDays(snapshot.as_of, p.listed_at);
    if (age !== null) ages.push(age);
  }
  return Math.round(median(ages));
}

/** One protocol's score under the model: its multiple, multipliers and implied value. */
export function scoreProtocol(
  p: SnapshotProtocol,
  asOf: string,
  multiples: PeerMultiples,
  unknownAgeDays: number,
): { implied: number; multiple: number; peers: number; growthPct: number; growthMult: number; maturityMult: number; age: number | null } {
  const peer = multiples.by_category.get(p.category ?? '');
  // The multiple is rounded to the 4 places the board states before it is used, so the implied
  // value a reader recomputes from the printed multiple is the board's figure to the dollar.
  const multiple = round4(peer === undefined
    ? Math.min(MODEL.multiple_cap, Math.max(MODEL.multiple_floor, multiples.global_median))
    : peer.multiple);
  const peers = peer === undefined ? 0 : peer.peers;
  const age = ageDays(asOf, p.listed_at);
  const growthPct = Math.min(MODEL.growth_cap, Math.max(MODEL.growth_floor, finite(p.change_7d, 0)));
  const growthMult = 1 + (growthPct / 100) * MODEL.growth_weight;
  const ageForModel = age ?? unknownAgeDays;
  const maturityMult = MODEL.maturity_floor
    + (Math.min(Math.max(ageForModel, 0), MODEL.maturity_days) / MODEL.maturity_days) * MODEL.maturity_range;
  const implied = Math.max(1, Math.round(p.tvl_usd * multiple * growthMult * maturityMult));
  return { implied, multiple, peers, growthPct, growthMult, maturityMult, age };
}

/** The ranked board: every watchlist slug, plus every other launch candidate, strongest first. */
export function buildBoard(snapshot: Snapshot): BoardRow[] {
  const multiples = peerMultiples(snapshot);
  const unknownAge = medianPreTokenAge(snapshot);
  const watch = new Set(snapshot.watchlist);
  const chosen = snapshot.protocols.filter((p) => watch.has(p.slug) || isLaunchCandidate(p));
  const scored = chosen.map((p) => ({ p, s: scoreProtocol(p, snapshot.as_of, multiples, unknownAge) }));
  scored.sort((a, b) => b.s.implied - a.s.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map(({ p, s }, i) => ({
    rank: i + 1,
    slug: p.slug,
    name: p.name,
    category: p.category,
    chains: p.chains,
    tvl_usd: p.tvl_usd,
    change_7d: p.change_7d,
    mcap_usd: p.mcap_usd,
    listed_at: p.listed_at,
    gecko_id: p.gecko_id,
    symbol: p.symbol,
    token_status: 'pre-token' as const,
    watchlist: watch.has(p.slug),
    age_days: s.age,
    implied_value_usd: s.implied,
    model: {
      category_multiple: round4(s.multiple),
      peer_count: s.peers,
      growth_pct: s.growthPct,
      growth_multiplier: round4(s.growthMult),
      maturity_multiplier: round4(s.maturityMult),
      age_days: s.age,
    },
    farm_steps: farmSteps(p, s.age),
  }));
}

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

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot);
  const live = liveRows(snapshot);
  const multiples = peerMultiples(snapshot);
  const watch = new Set(snapshot.watchlist);
  const setAside = snapshot.protocols.filter((p) => isPreToken(p) && !watch.has(p.slug) && !isLaunchCandidate(p)).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model: MODEL,
    model_version: MODEL_VERSION,
    global_median_multiple: round4(multiples.global_median),
    unknown_age_days: medianPreTokenAge(snapshot),
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: board.filter((r) => !r.watchlist).length,
    live_size: live.length,
    set_aside_size: setAside,
    rows: board.map((r) => ({
      rank: r.rank,
      slug: r.slug,
      name: r.name,
      category: r.category,
      chains: r.chains,
      tvl_usd: r.tvl_usd,
      change_7d: r.change_7d,
      listed_at: r.listed_at,
      age_days: r.age_days,
      watchlist: r.watchlist,
      implied_value_usd: r.implied_value_usd,
      category_multiple: r.model.category_multiple,
      peer_count: r.model.peer_count,
      growth_multiplier: r.model.growth_multiplier,
      maturity_multiplier: r.model.maturity_multiplier,
      farm_steps: r.farm_steps,
    })),
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
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

/**
 * A protocol's farm plan: seven steps, each an action with a cost and a time, derived from the
 * protocol's category, chains, TVL and age. Nothing in a plan is written for one protocol by name.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): string[] {
  const chain = mainChain(p);
  const family = familyOf(p.category);
  const capital = capitalFor(p);
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
    stepText(coreAction(family, p, capital, chain), `$${capital} of capital and ${gas}`, '20 minutes to set up'),
    stepText(
      secondChain === null ? cadenceAction(family, p, chain) : `${cadenceAction(family, p, chain)} In week two, repeat the core position on ${secondChain} from the same wallet if the protocol counts multi-chain activity.`,
      weekly,
      '10 minutes a week',
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
      `At the end of the ${hold} days, decide from the protocol's own announcements: keep farming if a program is live, or unwind the position in two transactions a day apart.`,
      gas,
      '20 minutes',
    ),
  ];
}
