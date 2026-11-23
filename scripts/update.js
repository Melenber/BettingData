/**
 * update.js — builds data.json from FPL, FBref and ClubElo.
 * Run: node scripts/update.js
 * Requires Node 20+ (built-in fetch) and cheerio.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as cheerio from 'cheerio';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const SCHEMA_VERSION = 1;
const FPL_BOOTSTRAP  = 'https://fantasy.premierleague.com/api/bootstrap-static/';
const FPL_FIXTURES   = 'https://fantasy.premierleague.com/api/fixtures/';
const FBREF_SHOOTING = 'https://fbref.com/en/comps/9/shooting/Premier-League-Stats';
const USER_AGENT     = 'BettingDataScript/1.0 (personal, non-commercial)';
const POSITION_MAP   = { 1: 'GKP', 2: 'DEF', 3: 'MID', 4: 'FWD' };

// ── helpers ────────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

function normalise(str) {
  return String(str)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')   // strip accents
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

async function fetchText(url, retries = 2, retryDelay = 20_000) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      console.log(`  retry ${attempt}/${retries} in ${retryDelay / 1000}s…`);
      await sleep(retryDelay);
    }
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(45_000),
      });
      if (res.status === 403 || res.status === 429) throw new Error(`HTTP ${res.status} (rate-limited/blocked)`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      lastErr = err;
      console.warn(`  attempt ${attempt + 1} failed: ${err.message}`);
    }
  }
  throw lastErr;
}

function loadFile(path) {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

// ── FPL ───────────────────────────────────────────────────────────────────

async function fetchFpl() {
  const [bootstrap, fixtures] = await Promise.all([fetchJson(FPL_BOOTSTRAP), fetchJson(FPL_FIXTURES)]);

  const teamsById = Object.fromEntries(bootstrap.teams.map(t => [t.id, t.name]));

  const players = bootstrap.elements.map(e => ({
    id:      e.id,
    name:    e.web_name,
    team:    teamsById[e.team] ?? 'Unknown',
    pos:     POSITION_MAP[e.element_type] ?? 'UNK',
    minutes: e.minutes,
    goals:   e.goals_scored,
    xg:      parseFloat(e.expected_goals) || 0,
    yellows: e.yellow_cards,
    threat:  parseFloat(e.threat) || 0,
    status:  e.status,
    chance:  e.chance_of_playing_next_round ?? 100,
    news:    e.news ?? '',
    sotPer90:   null,
    shotsPer90: null,
  }));

  const fixturesOut = fixtures.map(f => ({
    gw:        f.event,
    kickoff:   f.kickoff_time,
    home:      teamsById[f.team_h] ?? 'Unknown',
    away:      teamsById[f.team_a] ?? 'Unknown',
    homeGoals: f.team_h_score ?? null,
    awayGoals: f.team_a_score ?? null,
  }));

  return { players, fixtures: fixturesOut };
}

// ── FBref ─────────────────────────────────────────────────────────────────

async function fetchFbref() {
  console.log('Fetching FBref shooting stats…');
  const html = await fetchText(FBREF_SHOOTING);

  // FBref buries its tables inside HTML comments to deter scraping.
  // We extract the comment that contains the stats_shooting table id.
  let tableHtml = null;
  const re = /<!--([\s\S]*?)-->/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (m[1].includes('stats_shooting')) { tableHtml = m[1]; break; }
  }
  if (!tableHtml) throw new Error('stats_shooting table not found in HTML comments');

  const $ = cheerio.load(tableHtml);
  const rows = [];

  $('#stats_shooting tbody tr').each((_i, el) => {
    const $r = $(el);
    // Skip repeated header rows inserted by FBref
    if ($r.hasClass('thead') || $r.find('th[data-stat="ranker"]').length) return;

    const player       = $r.find('[data-stat="player"]').text().trim();
    const squad        = $r.find('[data-stat="squad"]').text().trim();
    const mins90sRaw   = $r.find('[data-stat="minutes_90s"]').text().trim();
    const shotsPer90Raw = $r.find('[data-stat="shots_per90"]').text().trim();
    const sotPer90Raw  = $r.find('[data-stat="shots_on_target_per90"]').text().trim();

    if (!player || !squad) return;

    rows.push({
      player,
      squad,
      mins90s:    parseFloat(mins90sRaw) || 0,
      shotsPer90: shotsPer90Raw ? (parseFloat(shotsPer90Raw) || null) : null,
      sotPer90:   sotPer90Raw   ? (parseFloat(sotPer90Raw)   || null) : null,
    });
  });

  if (rows.length < 200) throw new Error(`Only ${rows.length} rows parsed from FBref (expected 200+)`);
  console.log(`FBref: ${rows.length} rows parsed`);
  return rows;
}

// ── ClubElo ───────────────────────────────────────────────────────────────

async function fetchElo() {
  try {
    const today = new Date().toISOString().slice(0, 10);
    console.log(`Fetching ClubElo for ${today}…`);
    const text = await fetchText(`http://api.clubelo.com/${today}`);
    // CSV: Rank,Club,Country,Level,Elo,From,To
    const ratings = {};
    for (const line of text.trim().split('\n').slice(1)) {
      const p = line.split(',');
      if (p.length < 5) continue;
      if (p[2]?.trim() !== 'ENG' || parseInt(p[3]) !== 1) continue;
      const club = p[1]?.trim();
      const elo  = parseFloat(p[4]);
      if (club && !isNaN(elo)) ratings[club] = elo;
    }
    console.log(`ClubElo: ${Object.keys(ratings).length} ENG L1 teams`);
    return ratings;
  } catch (err) {
    console.warn(`ClubElo unavailable: ${err.message} — elo will be null for unset teams`);
    return null;
  }
}

// ── FBref → FPL matching ──────────────────────────────────────────────────

function matchFbref(fplPlayers, fbrefRows, teamAliases, nameFixes) {
  // Build map: every known alias/name → canonical FPL team name
  const aliasToFpl = {};
  for (const [fplName, fbrefAlias] of Object.entries(teamAliases ?? {})) {
    aliasToFpl[normalise(fbrefAlias)] = fplName;
    aliasToFpl[normalise(fplName)]    = fplName;
  }
  // Add identity fallback for any FBref squad names we haven't mapped yet
  for (const row of fbrefRows) {
    const key = normalise(row.squad);
    if (!aliasToFpl[key]) aliasToFpl[key] = row.squad;
  }

  const matches  = {};
  const unmatched = [];

  for (const p of fplPlayers) {
    const targetName = normalise(nameFixes?.[p.name] ?? p.name);

    const candidates = fbrefRows.filter(r => {
      const mappedTeam = aliasToFpl[normalise(r.squad)] ?? r.squad;
      if (mappedTeam !== p.team) return false;
      return normalise(r.player).includes(targetName);
    });

    const valid = candidates.filter(r => r.mins90s >= 3);

    if (valid.length === 1) {
      matches[p.id] = { sotPer90: valid[0].sotPer90, shotsPer90: valid[0].shotsPer90 };
    } else {
      matches[p.id] = { sotPer90: null, shotsPer90: null };
      if (candidates.length > 1) {
        // Multiple candidates with same surname + team — log so user can add nameFix
        console.log(`MULTI-MATCH: ${p.name} (${p.team}): ${candidates.map(c => c.player).join(' | ')}`);
      }
      if (p.minutes >= 450) {
        unmatched.push(`${p.name} (${p.team}, ${p.minutes}min)`);
      }
    }
  }

  if (unmatched.length > 0) {
    console.log('\nUnmatched players with 450+ minutes (add to nameFixes in manual.json if needed):');
    for (const u of unmatched) console.log(`  ${u}`);
    console.log('');
  }

  return matches;
}

// ── main ──────────────────────────────────────────────────────────────────

async function main() {
  const existing = loadFile(join(ROOT, 'data.json'));
  const manual   = loadFile(join(ROOT, 'manual.json')) ?? {};
  const { teamAliases = {}, nameFixes = {}, playerOverrides = [], elo: manualElo = {}, corners: manualCorners = {} } = manual;

  // ── FPL (required) ───────────────────────────────────────────────────
  console.log('Fetching FPL…');
  let players, fixtures;
  try {
    ({ players, fixtures } = await fetchFpl());
    console.log(`FPL: ${players.length} players, ${fixtures.length} fixtures`);
  } catch (err) {
    console.error(`FPL fetch failed: ${err.message}`);
    if (existing) console.error('Keeping existing data.json unchanged.');
    process.exit(1);
  }

  // ── FBref (optional — keep stale on failure) ─────────────────────────
  let fbrefMeta = existing?.fbref ?? { status: 'missing', updatedAt: null, rows: 0 };
  let fbrefRows  = null;

  try {
    fbrefRows = await fetchFbref();
    fbrefMeta = { status: 'ok', updatedAt: new Date().toISOString(), rows: fbrefRows.length };
  } catch (err) {
    console.warn(`FBref failed — keeping previous shots data: ${err.message}`);
    fbrefMeta = { ...fbrefMeta, status: 'stale' };
    // Restore previous per-player FBref values
    if (existing?.players) {
      const prev = Object.fromEntries(existing.players.map(p => [p.id, p]));
      for (const p of players) {
        p.sotPer90   = prev[p.id]?.sotPer90   ?? null;
        p.shotsPer90 = prev[p.id]?.shotsPer90 ?? null;
      }
    }
  }

  // ── Match FBref to FPL ───────────────────────────────────────────────
  if (fbrefRows) {
    const m = matchFbref(players, fbrefRows, teamAliases, nameFixes);
    for (const p of players) {
      p.sotPer90   = m[p.id]?.sotPer90   ?? null;
      p.shotsPer90 = m[p.id]?.shotsPer90 ?? null;
    }
  }

  // Apply playerOverrides from manual.json (always wins)
  for (const ov of playerOverrides) {
    const target = normalise(ov.name);
    const player = players.find(p => normalise(p.name).includes(target));
    if (player) {
      if (ov.sotPer90   != null) player.sotPer90   = ov.sotPer90;
      if (ov.shotsPer90 != null) player.shotsPer90 = ov.shotsPer90;
    } else {
      console.warn(`playerOverride not matched: "${ov.name}"`);
    }
  }

  // ── ClubElo ──────────────────────────────────────────────────────────
  const eloRatings = await fetchElo();

  // Build reverse alias map (ClubElo/FBref name → FPL team name)
  const aliasToFpl = {};
  for (const [fplName, alias] of Object.entries(teamAliases)) {
    aliasToFpl[alias]    = fplName;
    aliasToFpl[fplName]  = fplName;
  }

  const fplTeamNames = [...new Set(players.map(p => p.team))].sort();
  const teams = fplTeamNames.map(teamName => {
    // Manual Elo always wins
    let elo       = manualElo[teamName] ?? null;
    let eloSource = elo != null ? 'manual' : null;

    if (elo == null && eloRatings) {
      // Direct match first
      if (eloRatings[teamName] != null) {
        elo = eloRatings[teamName];
        eloSource = 'clubelo';
      } else {
        // Try via teamAliases: look for a ClubElo key that maps to this FPL team
        for (const [alias, fplName] of Object.entries(aliasToFpl)) {
          if (fplName === teamName && eloRatings[alias] != null) {
            elo = eloRatings[alias];
            eloSource = 'clubelo';
            break;
          }
        }
      }
      if (elo == null) console.log(`  No Elo for "${teamName}" — set in manual.json if needed`);
    }

    const c = manualCorners[teamName] ?? null;
    return {
      name:           teamName,
      elo:            elo != null ? Math.round(elo) : null,
      eloSource,
      cornersFor:     c?.for     ?? null,
      cornersAgainst: c?.against ?? null,
    };
  });

  // ── Write data.json ──────────────────────────────────────────────────
  const output = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt:   new Date().toISOString(),
    fpl:           { updatedAt: new Date().toISOString() },
    fbref:         fbrefMeta,
    players,
    teams,
    fixtures,
    playerOverrides,
  };

  writeFileSync(join(ROOT, 'data.json'), JSON.stringify(output, null, 2));
  console.log(`\n✓ data.json written — ${players.length} players, ${teams.length} teams, ${fixtures.length} fixtures`);
  if (fbrefMeta.status !== 'ok') {
    console.warn(`⚠ FBref status: ${fbrefMeta.status} (shots data may be stale)`);
  }
}

main().catch(err => {
  console.error(`\nFatal: ${err.message}`);
  process.exit(1);
});
