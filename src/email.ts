// =============================================================================
//  EMAIL NORMALIZATION + DISPOSABLE-DOMAIN CHECK (signup hardening).
//
//  Pure + unit-testable. Used by auth.ts so one inbox can't farm multiple
//  accounts: the NORMALIZED address is the account's uniqueness key (we create /
//  sign in / reset with it), and Supabase's own uniqueness then collapses aliases.
//
//  RULES — all providers: trim, lowercase, strip a "+tag" from the local part.
//          Gmail / Googlemail ONLY: also remove dots from the local part and
//          canonicalise googlemail.com → gmail.com (same inbox). Dots are LEFT
//          ALONE for every other provider (there they're significant).
//
//  The disposable list is a curated set of clearly-throwaway domains — it can't
//  catch everything (new ones appear daily); email VERIFICATION stays the real
//  gate. It's deliberately conservative to avoid blocking legitimate mail.
// =============================================================================

const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

/** The canonical uniqueness key for an email address. */
export function normalizeEmail(raw: string): string {
  const email = (raw || '').trim().toLowerCase();
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return email;   // not a normal address → leave as-is
  let local = email.slice(0, at);
  let domain = email.slice(at + 1);

  // strip a "+tag" (user+anything@ → user@) for ALL providers
  const plus = local.indexOf('+');
  if (plus >= 0) local = local.slice(0, plus);

  // Gmail / Googlemail: dots in the local part are ignored by Google, and the two
  // domains are the same inbox → strip dots + canonicalise to gmail.com.
  if (GMAIL_DOMAINS.has(domain)) {
    local = local.replace(/\./g, '');
    domain = 'gmail.com';
  }
  return `${local}@${domain}`;
}

// Clearly-disposable / throwaway inbox domains. Conservative on purpose.
export const DISPOSABLE_DOMAINS = new Set([
  // mailinator family
  'mailinator.com', 'mailinator.net', 'mailinator2.com', 'reallymymail.com',
  // 10/20/30-minute mail
  '10minutemail.com', '10minutemail.net', '20minutemail.com', '30minutemail.com',
  'minuteinbox.com', 'tempmailo.com', '1secmail.com', '1secmail.net', '1secmail.org',
  // guerrilla mail
  'guerrillamail.com', 'guerrillamail.net', 'guerrillamail.org', 'guerrillamail.biz',
  'guerrillamail.de', 'guerrillamail.info', 'guerrillamailblock.com', 'sharklasers.com',
  'grr.la', 'spam4.me',
  // temp-mail / tempmail
  'tempmail.com', 'temp-mail.org', 'tempmail.net', 'tempail.com', 'tempr.email',
  'tempmail.plus', 'tmpmail.org', 'tmpmail.net', 'mail-temp.com', 'mailtemp.info',
  'mytemp.email', 'temp-mail.io', 'tempinbox.com',
  // yopmail
  'yopmail.com', 'yopmail.net', 'yopmail.fr',
  // nada / getnada
  'getnada.com', 'nada.email',
  // throwaway / trash
  'throwawaymail.com', 'throwam.com', 'trashmail.com', 'trashmail.de', 'trashmail.net',
  'dispostable.com', 'discard.email', 'discardmail.com', 'spamgourmet.com', 'jetable.org',
  'maildrop.cc', 'mailcatch.com', 'mailnesia.com', 'mohmal.com', 'fakeinbox.com',
  'fakemail.net', 'emailfake.com', 'emailondeck.com', 'moakt.com', 'mailpoof.com',
  'easytrashmail.com', 'luxusmail.org', 'inboxbear.com', 'burnermail.io', 'mailexpire.com',
]);

/** True if the address's domain is a known disposable/throwaway inbox. */
export function isDisposableEmail(raw: string): boolean {
  const email = (raw || '').trim().toLowerCase();
  const at = email.lastIndexOf('@');
  if (at < 0) return false;
  const domain = email.slice(at + 1);
  return DISPOSABLE_DOMAINS.has(domain);
}
