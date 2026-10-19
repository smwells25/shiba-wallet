/**
 * Settings → Developer → "Measure the PIN hashing cost" (test networks
 * only). Pass p21f measured one app-PIN attempt (two scrypt hashes at
 * N = 2^16) at 245–258 s in the emulator's DEBUG development build, against
 * 240–313 ms for one hash under Node, so the PIN's cost setting
 * (PIN_SCRYPT_LOG2_N in ./pin.ts) must be chosen from a figure taken in a
 * RELEASE build on a real phone. This module takes that figure.
 *
 * WHAT IT TIMES. One hash at each size N = 2^12 … 2^16, one after another,
 * through pinScrypt — the very function the PIN check uses, with the PIN's
 * r, p and output length — on a fresh random 32-byte salt and a throwaway
 * input ("000000", which the PIN rules refuse as a PIN, so it can never be
 * anyone's PIN). The only difference from a PIN check is a progress
 * callback that noble calls every 1/10,000 of the work so the run can be
 * stopped (a counter and a comparison per mixing step; negligible against
 * the hash itself).
 *
 * LIMITS. Each size may run for at most PIN_COST_CEILING_MS (120 s); a size
 * that reaches it is stopped and the larger sizes are skipped, with a note.
 * The user can stop the run at any time; it stops inside the current hash.
 *
 * WHAT IT NEVER DOES. It never reads, writes or compares the PIN record or
 * any PIN, stores nothing (no store module is imported) and sends nothing
 * anywhere: the result exists only on the screen.
 */

import { randomBytes } from '@noble/hashes/utils.js';
import { isTestNetwork } from '../config/readiness.ts';
import { PIN_SALT_BYTES, PIN_SCRYPT_LOG2_N, pinScrypt } from './pin.ts';

/** The sizes measured, as log2 N, in order. */
export const PIN_COST_LOG2_SIZES: readonly number[] = Object.freeze([12, 13, 14, 15, 16]);
/** The longest one size may run before it is stopped and the larger ones skipped. */
export const PIN_COST_CEILING_MS = 120_000;
/** The throwaway input: refused as a PIN by isTriviallyGuessed, so never a real PIN. */
export const PIN_COST_INPUT = '000000';

export const PIN_COST_BUTTON = 'Measure the PIN hashing cost';
export const PIN_COST_STOP_BUTTON = 'Stop the measurement';
export const PIN_COST_HINT =
  'Test networks only. Times the scrypt hash the app PIN uses, on this phone: one hash at each size from N = 2^12 to N = 2^16, ' +
  `so the PIN's cost setting can be chosen from a real figure (the PIN uses N = 2^${PIN_SCRYPT_LOG2_N} today, and unlocking computes two hashes at that size). ` +
  'It uses a random salt and a throwaway input, never your PIN or its record; nothing is stored and nothing leaves this phone. ' +
  'A size that runs longer than 120 seconds is stopped and the larger sizes are skipped.';

export type PinCostStop = 'ceiling' | 'cancelled';
export type PinCostRow =
  | { log2N: number; status: 'measured'; ms: number }
  | { log2N: number; status: PinCostStop; ms: number }
  | { log2N: number; status: 'skipped'; reason: PinCostStop };

export interface PinCostPlatform {
  /** Platform.OS. */
  os: string;
  /** The Hermes marker `global.HermesInternal` is present. */
  hermes: boolean;
  /** __DEV__: a development (debug) bundle. */
  dev: boolean;
}

export interface PinCostReport {
  rows: PinCostRow[];
  /** Wall-clock milliseconds from the start of the run to its end. */
  totalMs: number;
  platform: PinCostPlatform;
  /** Every size measured (nothing stopped or skipped). */
  finished: boolean;
}

export interface PinCostDeps {
  now?: () => number;
  random?: (n: number) => Uint8Array;
  /** The hash; the checks replace it to run fast or to count calls. */
  hash?: typeof pinScrypt;
  /** Read at every progress callback and before every size. */
  isCancelled?: () => boolean;
  /** Called before each size starts (`current` = its log2 N) and once at the end (null). */
  onUpdate?: (rows: readonly PinCostRow[], current: number | null) => void;
}

/** Whether Settings → Developer offers the measurement: test networks only (readiness isTestNetwork). */
export function pinCostMeasurementOffered(caip2: string): boolean {
  return isTestNetwork(caip2);
}

/** The platform line's facts from Platform.OS, the global object and __DEV__. */
export function pinCostPlatform(os: string, globalObject: unknown, dev: boolean): PinCostPlatform {
  const g = globalObject as { HermesInternal?: unknown } | null | undefined;
  return { os, hermes: g?.HermesInternal !== undefined && g?.HermesInternal !== null, dev };
}

class PinCostStopped extends Error {
  readonly why: PinCostStop;
  constructor(why: PinCostStop) {
    super(why);
    this.name = 'PinCostStopped';
    this.why = why;
  }
}

function defaultNow(): number {
  const perf = (globalThis as { performance?: { now?: () => number } }).performance;
  return typeof perf?.now === 'function' ? perf.now() : Date.now();
}

/** Runs the measurement; resolves with every row (stopped and skipped sizes included). */
export async function measurePinHashCost(platform: PinCostPlatform, deps: PinCostDeps = {}): Promise<PinCostReport> {
  const now = deps.now ?? defaultNow;
  const random = deps.random ?? ((n: number) => randomBytes(n));
  const hash = deps.hash ?? pinScrypt;
  const cancelled = deps.isCancelled ?? (() => false);
  const rows: PinCostRow[] = [];
  const started = now();
  let stop: PinCostStop | null = null;
  for (const log2N of PIN_COST_LOG2_SIZES) {
    if (stop === null && cancelled()) stop = 'cancelled';
    if (stop !== null) {
      rows.push({ log2N, status: 'skipped', reason: stop });
      continue;
    }
    deps.onUpdate?.(rows.slice(), log2N);
    const salt = random(PIN_SALT_BYTES);
    const t0 = now();
    try {
      const out = await hash(PIN_COST_INPUT, salt, log2N, () => {
        if (cancelled()) throw new PinCostStopped('cancelled');
        if (now() - t0 > PIN_COST_CEILING_MS) throw new PinCostStopped('ceiling');
      });
      const ms = now() - t0;
      out.fill(0);
      rows.push({ log2N, status: 'measured', ms });
    } catch (e) {
      if (!(e instanceof PinCostStopped)) throw e;
      rows.push({ log2N, status: e.why, ms: now() - t0 });
      stop = e.why;
    }
  }
  deps.onUpdate?.(rows.slice(), null);
  return { rows, totalMs: now() - started, platform, finished: stop === null };
}

/** Whole milliseconds with thousands separators ("12,345"), independent of the phone's locale support. */
export function formatMs(ms: number): string {
  return String(Math.max(0, Math.round(ms))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** One result line per size. */
export function pinCostRowText(row: PinCostRow): string {
  const size = `N = 2^${row.log2N}`;
  if (row.status === 'measured') return `${size}: ${formatMs(row.ms)} ms`;
  if (row.status === 'ceiling') return `${size}: stopped after ${formatMs(row.ms)} ms, at the 120-second limit for one size (it takes longer than that).`;
  if (row.status !== 'skipped') return `${size}: stopped by you after ${formatMs(row.ms)} ms (not finished).`;
  return row.reason === 'ceiling'
    ? `${size}: skipped (a smaller size reached the 120-second limit).`
    : `${size}: not measured (stopped by you).`;
}

export function pinCostRunningText(log2N: number): string {
  return `Measuring N = 2^${log2N}…`;
}

export function pinCostTotalText(ms: number): string {
  return `Total time: ${formatMs(ms)} ms (wall clock).`;
}

export function pinCostPlatformText(p: PinCostPlatform): string {
  return `Platform: ${p.os} · Hermes: ${p.hermes ? 'yes' : 'no'} · development bundle (__DEV__): ${p.dev ? 'yes' : 'no'}`;
}

export const PIN_COST_RESULT_NOTE =
  'Each figure is one hash. Unlocking with the app PIN computes two hashes at the PIN\'s size. Nothing was stored.';

export function pinCostFailedText(detail: string): string {
  return `The measurement could not be run. Nothing was stored. Technical detail: ${detail}`;
}
