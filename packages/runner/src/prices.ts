/**
 * Where the Runner's triggers get their prices: a {@link PriceObserver} over the
 * SDK's indicative quote stream.
 *
 * THE ONE RULE THIS FILE EXISTS TO KEEP. `observe` returns `null` for "nothing
 * was observed", and it must never return a remembered number. The executor
 * reads `null` as a pass with no opinion; it reads a price as a fact about the
 * book right now. So every event that means this process can no longer prove the
 * feed is live — a gap it cannot fill, a dropped connection, a stream that gave
 * up, a topic the server refused — drops the cached frame rather than ageing it.
 * A quiet feed and a market that moved away must never look alike.
 *
 * WHY IT TALKS TO `QuoteStream` AND NOT TO `PriceWatcher`. The SDK's
 * `QuoteStreamPriceWatcher` is the right thing for `waitForPriceAndExecute`,
 * because that caller holds an intent and can therefore mint a real
 * `POST /quotes` when the stream has nothing. This one cannot: a `WatchKey`
 * carries a market, an outcome and a side and *deliberately no size*
 * (`strategy/gateway.ts`), and `CreateQuoteRequestBody` requires one. There is no
 * size-blind form of that request on the wire today. Falling back would mean
 * inventing a probe size and minting a priced, executable artifact to look at a
 * number — so this observer does not fall back. It reports `null` and the job
 * waits, which costs a tick and never costs a quote.
 *
 * WHY A `gap: true` SNAPSHOT IS STILL AN ANSWER. A resumed subscription's
 * snapshot admits that frames were missed, but it *is* the current state. Every
 * trigger in this package is a level test — a BUY ceiling, a SELL floor, read
 * against the book right now — and a level test on current state is unharmed by
 * not knowing the path. An edge trigger ("it crossed at some point") would have
 * to refuse this frame; none exists here, and one must not be added without
 * revisiting this paragraph. What the gap *is* recorded for is diagnosis: see
 * {@link QuoteStreamPriceObserver.topics}.
 *
 * WHAT IT NEVER DECIDES. Not whether a market is closed, not whether a job
 * should pause, not whether a strategy is over. `MARKET_CLOSED` on a topic makes
 * this observer go quiet, and going quiet makes the job wait — the market's
 * actual disposition is read from `getMarket` in preflight, which is the only
 * place allowed to end a job over it. An observer that ended jobs would be a
 * second lifecycle authority disagreeing with the first.
 */
import {
  streamTriggerPrice,
  type PredictOutcomeId,
  type PredictQuoteStreamFrame,
  type QuoteStream,
  type QuoteStreamEvent,
  type QuoteUnavailableReason,
} from '@waterx/predict-agent-sdk';

import type { Clock } from './clock.ts';
import type { PriceObserver, WatchKey } from './strategy/gateway.ts';

/** A topic not asked about for this long is released. */
const DEFAULT_IDLE_MS = 5 * 60_000;

export interface QuoteStreamPriceObserverOptions {
  readonly stream: QuoteStream;
  readonly now: Clock;
  /**
   * How long a topic survives without being asked about. Defaults to five
   * minutes, which is many scheduler ticks — the window only has to be longer
   * than the gap between two passes of the same job, not tuned to a strategy.
   */
  readonly idleMs?: number;
}

/** What this observer is holding, and why a topic is silent. For diagnosis. */
export interface PriceTopicStatus {
  readonly marketId: string;
  readonly outcomeId: PredictOutcomeId;
  readonly subscribedAt: string;
  readonly lastObservedAt: string | undefined;
  readonly lastAskedAt: string;
  /** Present when the last thing this topic reported was a refusal, not a price. */
  readonly unavailable: QuoteUnavailableReason | undefined;
  /** True when the newest frame admitted it could not account for what it missed. */
  readonly gapped: boolean;
}

interface Topic {
  readonly marketId: string;
  readonly outcomeId: PredictOutcomeId;
  readonly subscribedAt: string;
  release: () => void;
  frame: PredictQuoteStreamFrame | undefined;
  lastObservedAt: string | undefined;
  lastAskedAt: string;
  unavailable: QuoteUnavailableReason | undefined;
  gapped: boolean;
}

const topicKey = (watch: Pick<WatchKey, 'marketId' | 'outcomeId'>): string =>
  `${watch.marketId} ${watch.outcomeId}`;

/**
 * Subscribes on first sight of a market, and lets a market go by disuse.
 *
 * Subscription lifetime is the awkward part, because a `driveJob` pass is
 * transient and a subscription is not. The observer refuses to learn when a job
 * ends — it would have to be told, and every path that forgets to tell it (a
 * cancellation from another process, an expiry, a lease lost mid-pass, a crash)
 * leaks a subscription against a topic limit. So it expires topics by DISUSE
 * instead: a topic nobody has asked about within `idleMs` is released on the next
 * `observe`. A job that comes back simply re-subscribes and waits one more tick
 * for its snapshot, which is the cheap half of the trade.
 */
export class QuoteStreamPriceObserver implements PriceObserver {
  private readonly stream: QuoteStream;
  private readonly now: Clock;
  private readonly idleMs: number;
  private readonly topics_ = new Map<string, Topic>();
  private closed = false;

  constructor(options: QuoteStreamPriceObserverOptions) {
    this.stream = options.stream;
    this.now = options.now;
    this.idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
  }

  async observe(watch: WatchKey, signal?: AbortSignal): Promise<string | null> {
    // Nothing here awaits, so there is nothing for an abort to interrupt. What it
    // does mean is that this pass has been fenced out, and opening a subscription
    // for a job this Runner no longer holds would leak one.
    if (signal?.aborted || this.closed) return null;

    const at = this.now();
    const key = topicKey(watch);
    const topic = this.topics_.get(key) ?? this.subscribe(key, watch, at);
    topic.lastAskedAt = at;
    this.prune(at);

    if (topic.frame === undefined) return null;
    // Stale frames carry null prices by protocol, and `streamTriggerPrice`
    // returns null for them rather than the last good number.
    return streamTriggerPrice(watch.side, topic.frame);
  }

  /** What is subscribed and what each topic last said. Never a price. */
  topics(): readonly PriceTopicStatus[] {
    return [...this.topics_.values()]
      .map((topic) => ({
        marketId: topic.marketId,
        outcomeId: topic.outcomeId,
        subscribedAt: topic.subscribedAt,
        lastObservedAt: topic.lastObservedAt,
        lastAskedAt: topic.lastAskedAt,
        unavailable: topic.unavailable,
        gapped: topic.gapped,
      }))
      .sort((a, b) => topicKey(a).localeCompare(topicKey(b)));
  }

  /**
   * Releases every subscription. Idempotent, and after it every `observe`
   * answers `null` — a closed observer reports nothing rather than resurrecting
   * a feed the caller has shut down.
   */
  close(): void {
    this.closed = true;
    for (const [key, topic] of this.topics_) {
      this.topics_.delete(key);
      topic.release();
    }
  }

  private subscribe(key: string, watch: WatchKey, at: string): Topic {
    const topic: Topic = {
      marketId: watch.marketId,
      outcomeId: watch.outcomeId,
      subscribedAt: at,
      release: () => {},
      frame: undefined,
      lastObservedAt: undefined,
      lastAskedAt: at,
      unavailable: undefined,
      gapped: false,
    };
    this.topics_.set(key, topic);
    // Registered before subscribing: `onQuote` may answer with a snapshot
    // synchronously, and that frame must land on a topic the map already knows
    // about or the first observation is thrown away.
    topic.release = this.stream.onQuote(
      { marketId: watch.marketId, outcomeId: watch.outcomeId },
      (event) => this.apply(topic, event),
    );
    return topic;
  }

  private apply(topic: Topic, event: QuoteStreamEvent): void {
    if (event.type === 'FRAME') {
      topic.frame = event.frame;
      topic.lastObservedAt = this.now();
      topic.unavailable = undefined;
      topic.gapped = event.frame.gap;
      return;
    }
    // The cached frame goes, always. `DEGRADED` is the one worth staring at: the
    // stream has given up for the life of the process, so this topic will answer
    // null forever and the strategy will wait forever without erroring. That is
    // why `topics()` exists rather than this being a silent state.
    topic.frame = undefined;
    topic.unavailable = event.reason;
    topic.gapped = false;
  }

  /**
   * Comparisons only, deliberately. A clock string that does not parse makes
   * every comparison below false and nothing is released — a leaked
   * subscription, which is a bounded cost against the server's topic limit. The
   * alternative reading of NaN would be to release everything, and dropping a
   * live strategy's feed because a timestamp was malformed is the worse failure.
   */
  private prune(at: string): void {
    const cutoff = Date.parse(at) - this.idleMs;
    for (const [key, topic] of this.topics_) {
      if (Date.parse(topic.lastAskedAt) <= cutoff) {
        this.topics_.delete(key);
        topic.release();
      }
    }
  }
}
