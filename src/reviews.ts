// =============================================================================
//  STEER IT — REVIEWS client data layer ("leave a review → get premium free").
//
//  Thin Supabase wrapper (like leaderboard.ts / auth.ts). Writes go ONLY through the
//  SECURITY DEFINER submit_review() RPC — the client can't insert directly (RLS +
//  revoked grants). Submitting NEVER grants premium; a review lands as status='pending'
//  and premium is granted ONLY by the manual admin_approve_review() (owner/service role).
//  Reads are RLS-scoped (a user sees their OWN reviews; the public sees approved+consented).
//  Every call swallows errors into a result value so a hiccup never breaks the menu.
// =============================================================================
import { supabase } from './supabase';

export type ReviewStatus = 'pending' | 'approved' | 'rejected';

export interface SubmitReviewResult {
  ok: boolean;
  reason: string | null;   // auth | rating | text | exists | rate | error | null
}

export interface MyReview {
  rating: number;
  status: ReviewStatus;
  publishConsent: boolean;
}

/** Submit a review. rating 1–5 (any rating qualifies), body >= 10 chars, consent optional. */
export async function submitReview(rating: number, body: string, publishConsent: boolean): Promise<SubmitReviewResult> {
  try {
    const { data, error } = await supabase.rpc('submit_review', {
      p_rating: Math.round(rating), p_body: body, p_consent: !!publishConsent,
    });
    if (error) return { ok: false, reason: 'error' };
    const r = (data ?? {}) as { ok?: boolean; reason?: string | null };
    return { ok: !!r.ok, reason: r.reason ?? null };
  } catch { return { ok: false, reason: 'error' }; }
}

/** The caller's latest review (to show a "pending/approved" state instead of the form). */
export async function fetchMyReview(userId: string): Promise<MyReview | null> {
  try {
    const { data, error } = await supabase
      .from('reviews').select('rating, status, publish_consent')
      .eq('user_id', userId).order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (error || !data) return null;
    return {
      rating: Number(data.rating),
      status: data.status as ReviewStatus,
      publishConsent: !!data.publish_consent,
    };
  } catch { return null; }
}
