import { fmtTime } from "./api";

/** Calculate total time span swept by one effective screen width of horizontal drag. */
export function scrubSpanSeconds(duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  if (duration <= 90) return duration * 0.9;
  return Math.min(duration, Math.min(180, 81 + Math.sqrt(duration - 90) * 2.5));
}

/** Map a horizontal drag delta (after dead-zone offset) to a bounded seek target. */
export function computeScrubTarget(
  baseTime: number,
  deltaPx: number,
  containerSpanPx: number,
  duration: number,
): { target: number; delta: number; pct: number } {
  if (!Number.isFinite(duration) || duration <= 0) {
    return { target: baseTime, delta: 0, pct: 0 };
  }
  const effectiveWidth = Math.max(260, Math.min(containerSpanPx || 390, 720));
  const ratio = deltaPx / effectiveWidth;
  const curved = Math.sign(ratio) * Math.pow(Math.abs(ratio), 1.15);
  const rawDelta = curved * scrubSpanSeconds(duration);
  const maxTarget = Math.max(0, duration - 0.2);
  const target = Math.max(0, Math.min(maxTarget, baseTime + rawDelta));
  const delta = target - baseTime;
  const pct = Math.max(0, Math.min(100, (target / duration) * 100));
  return { target, delta, pct };
}

/** Format relative scrub offset such as +00:12 or -00:08. */
export function formatScrubDelta(deltaSeconds: number): string {
  const rounded = Math.round(deltaSeconds);
  if (rounded === 0) return "+00:00";
  return `${rounded > 0 ? "+" : "-"}${fmtTime(Math.abs(rounded))}`;
}
