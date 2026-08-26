// =============================================================================
//  Metallic-tone synthesis — turn ANY base colour into the 5-tone metallic RAMP the car
//  sprites use ([shadow, dark, mid, light, peak], darkest→brightest). The named skins
//  (blue/orange/…) hand-author these tones; this reproduces the SAME structure from an
//  arbitrary hue so a team colour (or any hex) can be recoloured onto EVERY car — the SVG
//  Stee-Rex (`metallicSkin(...tonesHex)`) and the three PNG sheen bakes (`metallicRampRGB`) —
//  with matching gloss. The ramp keeps the base HUE + SATURATION and varies only LIGHTNESS,
//  exactly as the authored ramps do (verified against blue #2f6ccb / orange #e06a1c), so blue
//  reads blue and orange reads orange on every car. Pure math, no DOM (leaf module).
// =============================================================================

export type RGB = [number, number, number];

export function hexToRgb(hex: string): RGB | null {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function rgbToHex(r: number, g: number, b: number): string {
  const h = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  const l = (mx + mn) / 2;
  let s = 0, h = 0;
  if (d > 1e-6) {
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  return [h, s, l];
}
function hslToRgb(h: number, s: number, l: number): RGB {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

// The 5 metallic tones from a base colour — hue + saturation preserved, lightness stepped, matching
// the authored ramps (shadow ~l·0.34, dark ~l·0.68, mid = base, light ~l+0.17, peak ~l+0.40).
export function metallicTonesRGB(hex: string): [RGB, RGB, RGB, RGB, RGB] {
  const base = hexToRgb(hex) ?? [233, 230, 224];   // bad hex → neutral (Stee-Rex white-ish)
  const [h, s, l] = rgbToHsl(base[0], base[1], base[2]);
  const mk = (ll: number, ss: number): RGB => hslToRgb(h, clamp01(ss), clamp01(ll));
  return [
    mk(l * 0.34, s * 1.06),                 // shadow — deep hue
    mk(l * 0.68, s),                        // dark
    [base[0], base[1], base[2]],            // mid — the base colour itself
    mk(Math.min(0.74, l + 0.17), s * 0.98), // light
    mk(Math.min(0.90, l + 0.40), s * 0.90), // peak — bright, still tinted
  ];
}
/** The ramp as RGB triples (for the PNG sheen bakes: blitz/fury/scrappy). */
export function metallicRampRGB(hex: string): number[][] {
  return metallicTonesRGB(hex).map((c) => [c[0], c[1], c[2]]);
}
/** The ramp as hex strings (for the Stee-Rex SVG `metallicSkin`). */
export function metallicTonesHex(hex: string): [string, string, string, string, string] {
  const t = metallicTonesRGB(hex);
  return [rgbToHex(...t[0]), rgbToHex(...t[1]), rgbToHex(...t[2]), rgbToHex(...t[3]), rgbToHex(...t[4])];
}
