/**
 * Turbo mode: find out how many parallel connections it takes to use all the
 * bandwidth that is actually available, without assuming any particular line
 * speed.
 *
 * The controller never looks at a configured or "expected" speed. It only
 * watches measured throughput: add connections, and keep them only if
 * throughput really rises. Whatever limit is binding (a server that caps each
 * connection, the server's total, the ISP line, Wi-Fi, the disk) shows up as
 * "more connections stopped helping", and scaling stops there.
 *
 * It is pure on purpose (no timers, sockets or files) so the algorithm can be
 * tested against simulated links of any speed.
 */

export interface TurboTuning {
  /** How often the engine feeds a throughput sample. */
  sampleMs: number;
  /** Samples ignored after a change while new connections ramp up. */
  settleSamples: number;
  /** Samples averaged to judge a change. */
  measureSamples: number;
  /** Relative throughput gain that justifies keeping the extra connections. */
  minGain: number;
  /** Connections multiply by this per step (at least `minStep` more). */
  growth: number;
  minStep: number;
}

export const DEFAULT_TURBO_TUNING: TurboTuning = {
  sampleMs: 500,
  settleSamples: 2,
  measureSamples: 3,
  minGain: 0.08,
  growth: 1.5,
  minStep: 2
};

export type TurboStopReason =
  /** More connections no longer increase throughput: the link (or server) is full. */
  | 'plateau'
  /** Reached the configured maximum while throughput was still rising. */
  | 'ceiling'
  /** The server pushed back (429/503/resets); keep the last safe count. */
  | 'server-limit'
  /** Not enough unfinished data left to split between more connections. */
  | 'no-work';

export type TurboDecision =
  | { action: 'hold' }
  | { action: 'grow'; target: number; baselineRate: number }
  | { action: 'stop'; target: number; reason: TurboStopReason; rate: number };

export interface TurboContext {
  /** True if the server rejected or reset connections since the last sample. */
  pushback: boolean;
  /**
   * How many more connections the unfinished data can really feed. A new
   * connection needs its own range to download, so near the end of a file this
   * drops to zero and adding workers would only make promises nobody can keep.
   */
  headroom: number;
}

/** Errors that mean "too many parallel connections" rather than a one-off glitch. */
export function isServerPushback(error: { code: string; statusCode: number | null }): boolean {
  return (
    error.statusCode === 429 ||
    error.statusCode === 503 ||
    error.code === 'HTTP_429' ||
    error.code === 'NETWORK' ||
    error.code === 'TIMEOUT'
  );
}

type Phase = 'baseline' | 'settling' | 'measuring' | 'done';

const mean = (values: number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;

export class TurboController {
  private phase: Phase = 'baseline';
  private current: number;
  private previous: number;
  private baseline = 0;
  private skipped = 0;
  private window: number[] = [];
  private headroom = 0;

  constructor(
    base: number,
    private readonly ceiling: number,
    private readonly tuning: TurboTuning = DEFAULT_TURBO_TUNING
  ) {
    this.current = Math.max(1, Math.floor(base));
    this.previous = this.current;
  }

  /** Number of connections the engine should currently be running. */
  get target(): number {
    return this.current;
  }

  get done(): boolean {
    return this.phase === 'done';
  }

  /** Feed one throughput sample in bytes per second. */
  sample(rate: number, context: TurboContext): TurboDecision {
    if (this.phase === 'done') return { action: 'hold' };
    if (context.pushback) {
      // Anything added since the last accepted step is what the server objected to.
      return this.stop(this.phase === 'baseline' ? this.current : this.previous, 'server-limit', this.baseline || rate);
    }
    this.headroom = Math.max(0, Math.floor(context.headroom));
    if (this.headroom < 1) return this.stop(this.current, 'no-work', rate);

    switch (this.phase) {
      case 'baseline': {
        if (this.skipped < this.tuning.settleSamples) {
          this.skipped += 1;
          return { action: 'hold' };
        }
        this.window.push(rate);
        if (this.window.length < this.tuning.measureSamples) return { action: 'hold' };
        this.baseline = mean(this.window);
        return this.grow();
      }
      case 'settling': {
        this.skipped += 1;
        if (this.skipped >= this.tuning.settleSamples) {
          this.phase = 'measuring';
          this.window = [];
        }
        return { action: 'hold' };
      }
      case 'measuring': {
        this.window.push(rate);
        if (this.window.length < this.tuning.measureSamples) return { action: 'hold' };
        const measured = mean(this.window);
        const gain = (measured - this.baseline) / Math.max(this.baseline, 1);
        if (gain < this.tuning.minGain) {
          // The extra connections did not help: give them back.
          return this.stop(this.previous, 'plateau', this.baseline);
        }
        this.baseline = measured;
        if (this.current >= this.ceiling) return this.stop(this.current, 'ceiling', measured);
        return this.grow();
      }
    }
  }

  private grow(): TurboDecision {
    const room = Math.min(this.ceiling, this.current + this.headroom);
    const next = Math.min(
      room,
      Math.max(this.current + this.tuning.minStep, Math.ceil(this.current * this.tuning.growth))
    );
    if (next <= this.current) return this.stop(this.current, room <= this.current && this.current < this.ceiling ? 'no-work' : 'ceiling', this.baseline);
    this.previous = this.current;
    this.current = next;
    this.phase = 'settling';
    this.skipped = 0;
    this.window = [];
    return { action: 'grow', target: next, baselineRate: this.baseline };
  }

  private stop(target: number, reason: TurboStopReason, rate: number): TurboDecision {
    this.current = target;
    this.phase = 'done';
    return { action: 'stop', target, reason, rate };
  }
}
