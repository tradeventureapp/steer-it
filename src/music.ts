// =============================================================================
//  MUSIC — a background synthwave playlist for the host (menu + in-game).
//
//  Host-only (desktop.ts). Phones are controllers and never load this. Purely a
//  presentation layer — no game state, no physics.
//
//  BEHAVIOUR:
//    • A shuffled playlist of the tracks in public/music/ — random order, the next
//      plays when one ends, cycling forever (a fresh shuffle each time the queue
//      is exhausted, never repeating a track across the seam).
//    • Plays in the game menu / selection / in-game (setActive(true)); paused on
//      the marketing landing (setActive(false)) so visitors get no autoplay music.
//    • NEVER autoplays on load — the browser blocks audio without a user gesture.
//      The first play() attempt that the autoplay policy rejects arms a one-shot
//      pointer/key listener that retries, so music begins on the first real
//      interaction in a music context (hitting PLAY / entering the game).
//    • Mute toggle via setEnabled() (persisted by the caller); default on.
//    • LIGHT ON STARTUP — only the CURRENT track loads plus the NEXT is preloaded
//      (two <audio> elements). The other tracks are never fetched until needed.
//    • CLEAN TRANSITIONS — a short crossfade between tracks and a fade in/out on
//      resume/pause, no harsh cuts.
// =============================================================================

const MUSIC_DIR = '/music/';
// The tracks in public/music/ (Vite serves public/ at the site root; a static
// build can't list a directory, so the set is declared here — keep in sync).
const TRACKS = [
  'usefulpix-chill-synthwave-background-music-for-youtube-shorts-and-videos-345551.mp3',
  'usefulpix-chill-synthwave-background-track-341854.mp3',
  'usefulpix-instrumental-synthwave-background-music-341852.mp3',
  'usefulpix-retro-synthwave-background-soundtrack-341853.mp3',
  'usefulpix-synthwave-background-beats-for-work-341857.mp3',
  'usefulpix-synthwave-background-music-for-videos-341855.mp3',
  'usefulpix-synthwave-beats-perfect-background-music-341849.mp3',
  'usefulpix-synthwave-retrowave-background-music-for-videos-345553.mp3',
  'usefulpix-synthwave-retrowave-background-music-for-youtube-shorts-and-videos-345552.mp3',
];

const VOL = 0.42;           // background level — present, not intrusive
const FADE_MS = 900;        // resume / pause fade
const CROSSFADE_S = 2.4;    // overlap between consecutive tracks

export interface MusicHandle {
  /** In a music context (menu / selection / in-game) vs not (the landing). */
  setActive(on: boolean): void;
  /** Mute toggle. */
  setEnabled(on: boolean): void;
  isEnabled(): boolean;
  trackCount(): number;
  destroy(): void;
}

export function createMusicPlayer(): MusicHandle {
  const n = TRACKS.length;
  const url = (i: number) => MUSIC_DIR + TRACKS[i];

  // two elements: one playing, one preloading the next (for a gapless crossfade)
  const els: HTMLAudioElement[] = [new Audio(), new Audio()];
  for (const el of els) { el.preload = 'none'; el.loop = false; el.volume = 0; }
  let curIdx = 0;                       // which element is the active one
  const cur = () => els[curIdx];
  const nxt = () => els[1 - curIdx];

  let enabled = true;                   // mute toggle
  let active = false;                   // music context (not the landing)
  let started = false;                  // playlist has begun
  let crossfading = false;
  let unlockArmed = false;
  let errStreak = 0;

  // rAF volume ramps, one per element
  const ramps = new Map<HTMLAudioElement, number>();
  function ramp(el: HTMLAudioElement, to: number, ms: number, done?: () => void) {
    const prev = ramps.get(el); if (prev) cancelAnimationFrame(prev);
    const from = el.volume; const t0 = performance.now();
    const step = (now: number) => {
      const k = ms <= 0 ? 1 : Math.min(1, (now - t0) / ms);
      el.volume = Math.max(0, Math.min(1, from + (to - from) * k));
      if (k < 1) ramps.set(el, requestAnimationFrame(step));
      else { ramps.delete(el); done?.(); }
    };
    ramps.set(el, requestAnimationFrame(step));
  }

  // ---- shuffled infinite queue (no repeat across the reshuffle seam) ----
  let queue: number[] = [];
  let qi = 0;
  function shuffle(): number[] {
    const a = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }
  function refill() {
    while (qi + 2 >= queue.length) {
      const block = shuffle();
      if (queue.length && n > 1 && block[0] === queue[queue.length - 1]) { [block[0], block[1]] = [block[1], block[0]]; }
      queue.push(...block);
    }
    if (qi > 2 * n) { queue = queue.slice(qi); qi = 0; }   // trim consumed history
  }

  function loadInto(el: HTMLAudioElement, trackIdx: number) {
    el.preload = 'auto';
    el.src = url(trackIdx);
    try { el.load(); } catch { /* ignore */ }
  }

  function playEl(el: HTMLAudioElement): Promise<void> {
    const p = el.play();
    return p instanceof Promise ? p : Promise.resolve();
  }

  function armUnlock() {
    if (unlockArmed) return;
    unlockArmed = true;
    const h = () => {
      document.removeEventListener('pointerdown', h);
      document.removeEventListener('keydown', h);
      unlockArmed = false;
      ensure();
    };
    document.addEventListener('pointerdown', h, { passive: true });
    document.addEventListener('keydown', h);
  }

  // ---- playback ----
  function begin() {
    started = true;
    queue = []; qi = 0; refill();
    curIdx = 0;
    loadInto(cur(), queue[qi]);
    cur().volume = 0;
    loadInto(nxt(), queue[qi + 1]);     // preload the next track
    playEl(cur()).then(() => { errStreak = 0; ramp(cur(), VOL, FADE_MS); })
      .catch(() => { started = false; armUnlock(); });   // autoplay blocked → wait for a gesture
  }

  function advance(hard: boolean) {
    // move to the preloaded next element
    const prev = cur();
    curIdx = 1 - curIdx;
    qi += 1; refill();
    const now = cur();
    if (!now.src) loadInto(now, queue[qi]);
    now.currentTime = 0;
    if (hard) {
      now.volume = 0;
      playEl(now).then(() => { errStreak = 0; ramp(now, VOL, FADE_MS); }).catch(() => { /* keep queue moving */ });
      prev.pause();
    }
    loadInto(prev, queue[qi + 1]);      // the just-freed element preloads the following
    prev.volume = 0;
  }

  function doCrossfade() {
    if (crossfading) return;
    crossfading = true;
    const from = cur(), to = nxt();
    if (!to.src) loadInto(to, queue[qi + 1]);
    to.currentTime = 0; to.volume = 0;
    playEl(to).catch(() => { /* if it fails the 'ended' path still advances */ });
    ramp(from, 0, CROSSFADE_S * 1000);
    ramp(to, VOL, CROSSFADE_S * 1000, () => {
      from.pause(); from.currentTime = 0;
      curIdx = 1 - curIdx;              // `to` is now current
      qi += 1; refill();
      loadInto(from, queue[qi + 1]);    // preload the following into the freed element
      from.volume = 0;
      crossfading = false;
    });
  }

  function pauseAll() {
    for (const el of els) { const r = ramps.get(el); if (r) cancelAnimationFrame(r); ramps.delete(el); }
    ramp(cur(), 0, FADE_MS, () => { for (const el of els) el.pause(); });
  }

  function ensure() {
    if (enabled && active) {
      if (!started) begin();
      else {
        playEl(cur()).then(() => ramp(cur(), VOL, FADE_MS)).catch(armUnlock);
        if (crossfading) playEl(nxt()).catch(() => {});
      }
    } else {
      if (started) pauseAll();
    }
  }

  // wire both elements' end/crossfade/error
  for (const el of els) {
    el.addEventListener('timeupdate', () => {
      if (el !== cur() || crossfading || !started) return;
      const d = el.duration;
      if (Number.isFinite(d) && d > 0 && d - el.currentTime <= CROSSFADE_S) doCrossfade();
    });
    el.addEventListener('ended', () => {
      if (el !== cur() || crossfading || !started) return;
      advance(true);
    });
    el.addEventListener('error', () => {
      if (el !== cur() || !started) return;
      if (++errStreak > n) { started = false; return; }   // whole set failing → stop trying
      advance(true);
    });
  }

  return {
    setActive(on: boolean) { if (on === active) return; active = on; ensure(); },
    setEnabled(on: boolean) { if (on === enabled) return; enabled = on; ensure(); },
    isEnabled() { return enabled; },
    trackCount() { return n; },
    destroy() {
      for (const el of els) { const r = ramps.get(el); if (r) cancelAnimationFrame(r); el.pause(); el.src = ''; }
      ramps.clear();
    },
  };
}
