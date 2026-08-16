// =============================================================================
//  STEER IT — LEADERBOARD client data layer (Phase 2 step 1: Time Attack).
//
//  A thin, typed wrapper over the Supabase client (mirrors how auth.ts wraps it).
//  It owns NO UI — desktop.ts renders; this module only talks to the DB:
//    • submitScore()   → the SECURITY DEFINER submit_score() RPC (the only write path).
//    • fetchBoard()    → the paginated menu board (public read + exact count).
//    • fetchTopAndOwn()→ the compact selection quick-view (top N + the caller's own row/rank).
//
//  Writes go through the RPC (auth + sanity floor + rate limit + best-only upsert,
//  server-side). Reads are direct table SELECTs — the table is PUBLIC READ (RLS), so
//  signed-out users can browse; only submitting needs a session. Every call swallows
//  errors into a result value so a network/DB hiccup can never break gameplay.
//
//  `mode` is shared with XP by design ('xp' → higher-is-better); only 'timeattack' is
//  wired today, but the direction is already parameterised so XP drops in later.
// =============================================================================
import { supabase } from './supabase';

export type LbMode = 'timeattack' | 'xp';

export interface BoardKey {
  mode: LbMode;
  trackId: string;
  carKey: string;
  surface: string;   // '' = none / encoded in trackId (the ovals' asphalt/dirt are separate track ids)
}

export interface LbRow {
  userId: string;
  nickname: string | null;   // null = user never set a nickname; the UI falls back
  value: number;             // timeattack: lap ms (lower is better)
  rank: number;              // 1-based
}

export interface SubmitResult {
  ok: boolean;         // accepted by the RPC (auth + sanity + rate all passed)
  updated: boolean;    // true = it was a new server-side best (a row was written)
  reason: string | null;   // auth | invalid | rate | floor | not_better | error | null
}

export interface BoardPage {
  rows: LbRow[];
  total: number;       // total entries for this key (for page controls)
  page: number;        // 0-based
  pageSize: number;
}

export interface QuickView {
  top: LbRow[];        // top N
  own: LbRow | null;   // the caller's own row with its true rank (null = no entry / signed out)
}

export const LB_PAGE_SIZE = 25;

// Sort direction per mode: Time Attack is lap TIME (ascending = best first); XP will be
// score (descending). Kept in one place so reads + the own-rank count agree.
function ascending(mode: LbMode): boolean { return mode !== 'xp'; }

const SEL = 'user_id, nickname, value';

/**
 * Submit a result via the anti-cheat RPC. Only call for a genuine new PERSONAL BEST.
 * `proof` is the zone/split proof-of-play (see zones.ts): TA sends `{z:[6 split ms]}`, XP sends
 * `{zc,laps,ord}`. The RPC validates its STRUCTURE (all TA zones present + monotonic; XP data
 * internally consistent) on top of the auth + floor/ceiling + rate-limit gates.
 */
export async function submitScore(k: BoardKey, value: number, proof: unknown = {}): Promise<SubmitResult> {
  try {
    const { data, error } = await supabase.rpc('submit_score', {
      p_mode: k.mode, p_track_id: k.trackId, p_car_key: k.carKey,
      p_surface: k.surface, p_value: Math.round(value), p_proof: proof,
    });
    if (error) return { ok: false, updated: false, reason: 'error' };
    const r = (data ?? {}) as { ok?: boolean; updated?: boolean; reason?: string | null };
    return { ok: !!r.ok, updated: !!r.updated, reason: r.reason ?? null };
  } catch { return { ok: false, updated: false, reason: 'error' }; }
}

/** One page of the full board for `k`, ordered best-first, with the total row count. */
export async function fetchBoard(k: BoardKey, page: number): Promise<BoardPage | null> {
  const from = Math.max(0, page) * LB_PAGE_SIZE;
  const to = from + LB_PAGE_SIZE - 1;
  try {
    const { data, error, count } = await supabase
      .from('leaderboard')
      .select(SEL, { count: 'exact' })
      .eq('mode', k.mode).eq('track_id', k.trackId).eq('car_key', k.carKey).eq('surface', k.surface)
      .order('value', { ascending: ascending(k.mode) })
      .order('updated_at', { ascending: true })   // stable tie-break: earlier PB ranks higher
      .range(from, to);
    if (error) return null;
    const rows: LbRow[] = (data ?? []).map((d, i) => ({
      userId: d.user_id as string,
      nickname: (d.nickname as string | null) ?? null,
      value: Number(d.value),
      rank: from + i + 1,
    }));
    return { rows, total: count ?? rows.length, page: Math.max(0, page), pageSize: LB_PAGE_SIZE };
  } catch { return null; }
}

/** Top `topN` for `k`, plus the caller's own row + true rank (even if outside the top). */
export async function fetchTopAndOwn(
  k: BoardKey, topN: number, userId: string | null,
): Promise<QuickView | null> {
  try {
    const { data, error } = await supabase
      .from('leaderboard')
      .select(SEL)
      .eq('mode', k.mode).eq('track_id', k.trackId).eq('car_key', k.carKey).eq('surface', k.surface)
      .order('value', { ascending: ascending(k.mode) })
      .order('updated_at', { ascending: true })
      .range(0, Math.max(0, topN - 1));
    if (error) return null;
    const top: LbRow[] = (data ?? []).map((d, i) => ({
      userId: d.user_id as string,
      nickname: (d.nickname as string | null) ?? null,
      value: Number(d.value),
      rank: i + 1,
    }));

    let own: LbRow | null = null;
    if (userId) {
      const inTop = top.find((r) => r.userId === userId);
      if (inTop) {
        own = inTop;
      } else {
        // Fetch the user's own best row...
        const { data: od } = await supabase
          .from('leaderboard').select(SEL)
          .eq('mode', k.mode).eq('track_id', k.trackId).eq('car_key', k.carKey).eq('surface', k.surface)
          .eq('user_id', userId).maybeSingle();
        if (od) {
          const myVal = Number(od.value);
          // ...and its rank = (count of strictly-better entries) + 1.
          const q = supabase.from('leaderboard')
            .select('id', { count: 'exact', head: true })
            .eq('mode', k.mode).eq('track_id', k.trackId).eq('car_key', k.carKey).eq('surface', k.surface);
          const { count } = await (ascending(k.mode) ? q.lt('value', myVal) : q.gt('value', myVal));
          own = {
            userId, nickname: (od.nickname as string | null) ?? null,
            value: myVal, rank: (count ?? 0) + 1,
          };
        }
      }
    }
    return { top, own };
  } catch { return null; }
}
