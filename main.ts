// Token Radar — entrypoint (token-radar-01).
//
// Pipeline: read the sealed snapshot, score every launch candidate with the
// fitted model in lib/model.ts, then emit the ranked board, the dashboard
// data script, the dashboard and screenshot assets, and the dossier that
// describes them. The dossier is written last on purpose: the scorer rebuilds
// it from the output folder and compares bytes, so it must describe the
// finished folder, never a half-written one.
//
// Run locally with MAKEFUN_OUTPUT_DIR=<dir> node main.ts --input <snapshot.json|dir>

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const repoRoot = fileURLToPath(new URL('.', import.meta.url));

// The caps the scorer rebuilds the dossier with: dossier text, screenshots, dashboard.
const DOSSIER_TEXT_MAX = 65_536;
const SHOT_LIMITS = { max: 4, max_bytes: 524_288 };
const PAGE_LIMITS = { max_files: 400, max_bytes: 4_194_304 };
const SHOT_NAME_OK = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** One CLI flag's value: `--name value` or `--name=value`, else the fallback. */
function flagValue(name: string, fallback: string): string {
  const argv = process.argv;
  const bare = argv.indexOf(`--${name}`);
  if (bare !== -1 && bare + 1 < argv.length) return argv[bare + 1]!;
  const joined = argv.find((a) => a.startsWith(`--${name}=`));
  return joined === undefined ? fallback : joined.slice(name.length + 3);
}

/** The snapshot file a --input argument points at: itself when .json, else its snapshot.json. */
function snapshotFile(inputArg: string): string {
  return inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
}

/** Copy a folder's regular files (dotfiles skipped) into the output; returns the names copied. */
function copyAssets(sourceDir: string, targetDir: string): string[] {
  if (!existsSync(sourceDir)) return [];
  mkdirSync(targetDir, { recursive: true });
  const names: string[] = [];
  for (const name of readdirSync(sourceDir)) {
    if (name.startsWith('.')) continue;
    const from = join(sourceDir, name);
    if (!statSync(from).isFile()) continue;
    copyFileSync(from, join(targetDir, name));
    names.push(name);
  }
  return names;
}

function fail(message: string, code: number): never {
  process.stderr.write(`token radar: ${message}\n`);
  process.exit(code);
}

const snapPath = snapshotFile(flagValue('input', '/input'));
if (!existsSync(snapPath)) {
  fail(`no snapshot at ${snapPath}: pass --input <snapshot.json|directory> or mount the sealed /input`, 2);
}
const outDir = flagValue('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(snapPath, 'utf8'));
const { board, radar } = buildRadar(snapshot);
const refusal = boardIssue(board, snapshot);
if (refusal !== null) {
  fail(`the model wrote a board the gate refuses: ${refusal}`, 1);
}

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(outDir, 'data.js'), dataScript(radar));

const pageNames = copyAssets(join(repoRoot, 'dashboard'), join(outDir, 'dashboard'));
const shotNames = copyAssets(join(repoRoot, 'screenshots'), join(outDir, 'screenshots'));
if (shotNames.length < 3) {
  fail(`screenshots/ holds ${shotNames.length} image${shotNames.length === 1 ? '' : 's'}: hand in 3, the board, a detail view and a filtered view`, 1);
}
for (const name of shotNames) {
  if (!SHOT_NAME_OK.test(name)) {
    fail(`screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters`, 1);
  }
}

writeFileSync(join(outDir, 'dossier.json'), buildDossier(outDir, {
  text_max_bytes: DOSSIER_TEXT_MAX,
  screenshots: SHOT_LIMITS,
  dashboard: PAGE_LIMITS,
}));

process.stdout.write(
  `token radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ` +
  `${board.length} rows ranked (${radar.early_size} early, ${radar.set_aside_size} products set aside, ${radar.live_size} live shown apart)\n` +
  `token radar: wrote board.json, data.js, dashboard/ (${pageNames.length} files), screenshots/ (${shotNames.length} images) and dossier.json in ${outDir}\n`,
);
