// =============================================================================
//  ORIENTATION — quaternion + relative-twist math for the RECENTER steering rescue.
//
//  This is the PURE math behind the opt-in RECENTER button (phone.ts owns the sensor
//  wiring + UI). It exists so a player whose device's DEFAULT gravity mapping is wrong
//  (offset zero AND/OR a swapped/flipped axis — the classic Android device-frame
//  mismatch) can tap RECENTER and drive on a RELATIVE steering path instead:
//
//    steer = the TWIST (roll) of the phone about its screen-normal ("wheel") axis,
//            measured RELATIVE to a reference orientation captured at the tap.
//
//  Why quaternions (not "subtract a beta/gamma offset"): a scalar Euler offset breaks
//  at gimbal lock (phone near-vertical, beta ≈ ±90°, where the Euler angles degenerate)
//  and cannot express an axis swap. We convert the reading to a quaternion FIRST, take
//  the RELATIVE rotation from the reference, and extract only the twist about the wheel
//  axis via a swing-twist decomposition — continuous everywhere, device-frame-agnostic
//  (the reference defines "straight", so it doesn't matter how the OEM orients sensors).
//
//  DOM/sensor-free ⇒ unit-testable like zones.ts / lobby.ts. Angles at the API edge are
//  DEGREES (matching the DeviceOrientation event + phone.ts's existing steering units).
// =============================================================================

export interface Quat { w: number; x: number; y: number; z: number; }

const DEG = Math.PI / 180;

// The sign that makes the RECENTER (quaternion) path steer the SAME DIRECTION as the working
// default path. A physical wheel-roll gives relativeTwistDeg() one sign, but the default gravity
// path reads that same roll with the OPPOSITE sign (iOS `comp = -ay`), so an unflipped twist
// inverts the steering (confirmed on a real device: right tilt steered left). -1 lines the two
// paths up. This is DEVICE-INDEPENDENT: the twist is a geometric rotation about the screen normal,
// taken RELATIVE to the captured reference and corrected by screen.orientation.angle — it does NOT
// depend on guessing the raw sensor frame (which is exactly what varies per Android model). So the
// one flip is correct on every spec-conformant device, not just the reporter's. (See the headless
// cross-check test: for a level reference, gravity path and quaternion×SIGN agree in sign.)
export const QUAT_STEER_SIGN = -1;

export function quatMul(a: Quat, b: Quat): Quat {
  return {
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  };
}

export function quatConj(q: Quat): Quat { return { w: q.w, x: -q.x, y: -q.y, z: -q.z }; }

export function quatNorm(q: Quat): Quat {
  const n = Math.hypot(q.w, q.x, q.y, q.z) || 1;
  return { w: q.w / n, x: q.x / n, y: q.y / n, z: q.z / n };
}

/** A rotation of `angleRad` about the Z axis (the screen normal / wheel axis). */
export function rotZ(angleRad: number): Quat {
  return { w: Math.cos(angleRad / 2), x: 0, y: 0, z: Math.sin(angleRad / 2) };
}

/**
 * W3C DeviceOrientation Euler angles → quaternion (device frame → world frame).
 * Intrinsic Tait-Bryan Z-X'-Y'' (alpha about Z, beta about X', gamma about Y''), the
 * standard MDN/Three.js 'ZXY' conversion. Angles in RADIANS. Uses only half-angle
 * sin/cos (no division), so it is well-defined and CONTINUOUS through beta = ±90°
 * (the Euler gimbal singularity) — the whole reason we go via quaternions.
 */
export function eulerToQuat(alpha: number, beta: number, gamma: number): Quat {
  const cX = Math.cos(beta / 2),  sX = Math.sin(beta / 2);
  const cY = Math.cos(gamma / 2), sY = Math.sin(gamma / 2);
  const cZ = Math.cos(alpha / 2), sZ = Math.sin(alpha / 2);
  return {
    w: cX * cY * cZ - sX * sY * sZ,
    x: sX * cY * cZ - cX * sY * sZ,
    y: cX * sY * cZ + sX * cY * sZ,
    z: cX * cY * sZ + sX * sY * cZ,
  };
}

/**
 * Correct for the screen's rotation (`screen.orientation.angle`, 0/90/180/270). The wheel
 * axis is the screen normal (device Z); the screen angle is a rotation about that same Z,
 * so we compose it on the RIGHT (body frame). Applied consistently to the reference and to
 * every live reading, it normalises the frame to "screen-up" — so the four screen angles
 * and devices whose natural orientation is landscape all map the same way.
 */
export function applyScreenAngle(q: Quat, screenAngleDeg: number): Quat {
  return quatMul(q, rotZ(-screenAngleDeg * DEG));
}

/** A full reading (Euler degrees + screen angle) → screen-normalised quaternion. */
export function readingToQuat(
  alphaDeg: number, betaDeg: number, gammaDeg: number, screenAngleDeg: number,
): Quat {
  return applyScreenAngle(
    eulerToQuat(alphaDeg * DEG, betaDeg * DEG, gammaDeg * DEG), screenAngleDeg,
  );
}

/**
 * Swing-twist decomposition: the TWIST of `q` about the Z axis (the wheel axis), in
 * degrees, wrapped to (-180, 180]. Only the Z component survives — rotation about X
 * (pitch) or Y (the other tilt) is discarded — which is what makes the steering
 * pitch-invariant. Continuous everywhere; when the rotation is ~180° about an axis in
 * the XY plane (no Z component at all) it returns 0 rather than blowing up.
 */
export function twistAboutZDeg(q: Quat): number {
  let w = q.w, z = q.z;
  const n = Math.hypot(w, z);
  if (n < 1e-9) return 0;   // pure XY-plane 180° flip — no defined Z twist
  w /= n; z /= n;
  let ang = 2 * Math.atan2(z, w);   // (-2π, 2π]
  if (ang > Math.PI) ang -= 2 * Math.PI;
  if (ang <= -Math.PI) ang += 2 * Math.PI;
  return ang / DEG;
}

/**
 * The steering roll: the twist about the wheel axis of the CURRENT orientation RELATIVE
 * to the reference. `qRel = conj(qRef) · qCur` is the rotation since the reference was
 * captured, expressed in the reference frame; its Z-twist is how far the wheel has turned.
 * Zero at the reference pose, symmetric ±, continuous through vertical.
 */
export function relativeTwistDeg(qRef: Quat, qCur: Quat): number {
  return twistAboutZDeg(quatMul(quatConj(qRef), qCur));
}
