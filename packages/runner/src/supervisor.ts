/**
 * The heartbeat loop, and the rule that a Runner stops writing before it finds
 * out why it lost the right to.
 *
 * Two clocks are kept alive here and they answer different questions:
 *
 * - **The instance heartbeat** answers *is anyone watching these strategies?*
 *   With a self-hosted Runner that is product-visible, not diagnostic: a stale
 *   heartbeat is the difference between a monitored strategy and an unmonitored
 *   one (ADR-0001 §6), and `recoverJobs` reports stale instances for exactly that
 *   reason.
 * - **The job lease** answers *am I still the writer for this job?* The store
 *   enforces the fence, so a superseded writer's next call fails `LEASE_LOST` —
 *   but "fails on the next call" is too late if the next call is the one that
 *   places the order. So the keeper aborts the job's work the instant renewal
 *   fails, and the executor that will eventually sit behind that `AbortSignal`
 *   stops before it learns the reason.
 *
 * The subtle half is the second failure mode. A renewal that fails because the
 * database is briefly unavailable is *not* `LEASE_LOST` — nobody took the job —
 * but it is just as dangerous, because the lease is still ticking down and
 * another Runner may claim it the moment it expires. So the keeper also aborts
 * when the held lease is within `safetyMarginMs` of expiring, whatever the
 * reason it could not be renewed. The margin has to be wider than the worst
 * in-flight request: writing after that point means writing while somebody else
 * may legitimately believe they own the job.
 */
import type { Clock } from './clock.ts';
import { isJobStoreError } from './errors.ts';
import type { JobLease } from './job.ts';
import type { JobStore } from './store.ts';

export type LeaseLossReason =
  /** Another instance claimed the job; this writer has been fenced out. */
  | 'LEASE_LOST'
  /** The lease could not be renewed in time. Nobody may have taken it — irrelevant. */
  | 'UNRENEWABLE'
  /** The job ended, or the daemon is shutting down. */
  | 'RELEASED';

export interface HeldLease {
  readonly jobId: string;
  /** The lease as last renewed. Read it per call; renewal replaces `expiresAt`. */
  current(): JobLease;
  /** Aborted the moment this instance may no longer write for the job. */
  readonly signal: AbortSignal;
}

export interface LeaseKeeperOptions {
  readonly store: JobStore;
  readonly instanceId: string;
  readonly now: Clock;
  readonly leaseTtlMs: number;
  /** How often to renew. Must leave room for several failures inside one TTL. */
  readonly renewIntervalMs: number;
  /**
   * How long before expiry to stop writing. Must exceed the longest request the
   * executor can have in flight, or a write can land after another Runner has
   * legitimately claimed the job.
   */
  readonly safetyMarginMs: number;
  readonly onLeaseLost?: (jobId: string, reason: LeaseLossReason) => void;
  readonly onError?: (error: unknown, context: string) => void;
}

interface Entry {
  lease: JobLease;
  readonly controller: AbortController;
}

export class LeaseKeeper {
  private readonly entries = new Map<string, Entry>();
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(private readonly options: LeaseKeeperOptions) {
    if (options.renewIntervalMs >= options.leaseTtlMs) {
      throw new Error('renewIntervalMs must be shorter than leaseTtlMs');
    }
    if (options.safetyMarginMs >= options.leaseTtlMs) {
      throw new Error('safetyMarginMs must be shorter than leaseTtlMs');
    }
  }

  /** Takes a claimed lease under management. Idempotent per job. */
  hold(lease: JobLease): HeldLease {
    const existing = this.entries.get(lease.jobId);
    if (existing !== undefined) {
      existing.lease = lease;
      return this.view(lease.jobId, existing);
    }
    const entry: Entry = { lease, controller: new AbortController() };
    this.entries.set(lease.jobId, entry);
    return this.view(lease.jobId, entry);
  }

  held(): readonly string[] {
    return [...this.entries.keys()].sort();
  }

  lease(jobId: string): JobLease | undefined {
    return this.entries.get(jobId)?.lease;
  }

  isHeld(jobId: string): boolean {
    return this.entries.has(jobId);
  }

  /**
   * Stops managing a job whose lease the store has already cleared — a terminal
   * transition does that in the same transaction. Calling `release` here instead
   * would fail `LEASE_LOST` against a lease that was correctly given up.
   */
  forget(jobId: string, reason: LeaseLossReason = 'RELEASED'): void {
    const entry = this.entries.get(jobId);
    if (entry === undefined) return;
    this.entries.delete(jobId);
    entry.controller.abort(new Error(`lease for ${jobId} ended: ${reason}`));
    this.options.onLeaseLost?.(jobId, reason);
  }

  /** Hands the job back so another Runner need not wait out the TTL. */
  async release(jobId: string): Promise<void> {
    const entry = this.entries.get(jobId);
    if (entry === undefined) return;
    this.entries.delete(jobId);
    entry.controller.abort(new Error(`lease for ${jobId} released`));
    try {
      await this.options.store.releaseJob(entry.lease, this.options.now());
    } catch (error) {
      // Already lost, already terminal, or the store is unavailable. The local
      // side is what mattered and it is done: this instance has stopped writing.
      this.options.onError?.(error, `release ${jobId}`);
    }
    this.options.onLeaseLost?.(jobId, 'RELEASED');
  }

  /**
   * One pass: renew the instance heartbeat, then every held lease.
   *
   * Public so tests can drive it without a timer. The daemon uses `start`.
   */
  async tick(): Promise<void> {
    const at = this.options.now();
    try {
      await this.options.store.heartbeat(this.options.instanceId, at);
    } catch (error) {
      // A missed heartbeat makes this instance *look* stale to another Runner.
      // It does not make this instance's leases invalid, and dropping jobs over
      // it would be the recovery equivalent of a false positive.
      this.options.onError?.(error, 'heartbeat');
    }

    for (const [jobId, entry] of [...this.entries]) {
      try {
        entry.lease = await this.options.store.renewLease(
          entry.lease,
          at,
          this.options.leaseTtlMs,
        );
      } catch (error) {
        if (isJobStoreError(error) && error.code === 'LEASE_LOST') {
          // Fenced out. Stop first; the caller can read the reason afterwards.
          this.entries.delete(jobId);
          entry.controller.abort(error);
          this.options.onLeaseLost?.(jobId, 'LEASE_LOST');
          continue;
        }
        this.options.onError?.(error, `renew ${jobId}`);
        // Not fenced out, but not renewed either. The lease is still expiring,
        // and past the margin this instance can no longer prove it owns the job.
        const remainingMs = Date.parse(entry.lease.expiresAt) - Date.parse(at);
        if (remainingMs <= this.options.safetyMarginMs) {
          this.entries.delete(jobId);
          entry.controller.abort(error);
          this.options.onLeaseLost?.(jobId, 'UNRENEWABLE');
        }
      }
    }
  }

  start(): void {
    if (this.timer !== undefined || this.stopped) return;
    const timer = setInterval(() => {
      void this.tick();
    }, this.options.renewIntervalMs);
    // The Runner's own lifetime is decided by its socket and its signal handlers,
    // never by a renewal timer holding the event loop open after `stop`.
    timer.unref();
    this.timer = timer;
  }

  /** Stops renewing and gives every held lease back. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    for (const jobId of [...this.entries.keys()]) {
      await this.release(jobId);
    }
  }

  private view(jobId: string, entry: Entry): HeldLease {
    return {
      jobId,
      current: () => entry.lease,
      signal: entry.controller.signal,
    };
  }
}
