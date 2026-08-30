import {
  decideProviderPoll,
  providerTrackingPollIntervalMs,
  type ProviderPosition,
} from './request-tracking';

type ProviderTrackingFetchResult = { status: number; body: unknown };

type ProviderTrackingPollerDependencies = {
  canPoll: () => boolean;
  fetchPosition: (signal: AbortSignal) => Promise<ProviderTrackingFetchResult>;
  onPosition: (position: ProviderPosition) => void;
  onUnavailable: () => void;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancelScheduled?: (handle: unknown) => void;
};

export type ProviderTrackingPoller = {
  sync: () => Promise<void>;
  dispose: () => void;
};

/**
 * Polling lifecycle isolated from React so visibility, close, abort, and
 * terminal-error behavior can be tested without exposing staff credentials.
 */
export function createProviderTrackingPoller(
  dependencies: ProviderTrackingPollerDependencies,
): ProviderTrackingPoller {
  const schedule =
    dependencies.schedule ??
    ((callback, delayMs) => setTimeout(callback, delayMs));
  const cancelScheduled =
    dependencies.cancelScheduled ?? ((handle) => clearTimeout(handle as number));
  let stopped = false;
  let timer: unknown;
  let activeRequest: AbortController | undefined;

  const clearScheduledPoll = () => {
    if (timer !== undefined) cancelScheduled(timer);
    timer = undefined;
  };

  const stopUnavailable = () => {
    if (stopped) return;
    stopped = true;
    clearScheduledPoll();
    dependencies.onUnavailable();
  };

  const scheduleNextPoll = () => {
    if (stopped || !dependencies.canPoll() || timer !== undefined) return;
    timer = schedule(() => {
      timer = undefined;
      void sync();
    }, providerTrackingPollIntervalMs);
  };

  const sync = async () => {
    if (stopped) return;
    if (!dependencies.canPoll()) {
      clearScheduledPoll();
      activeRequest?.abort();
      activeRequest = undefined;
      return;
    }
    if (activeRequest) return;
    clearScheduledPoll();

    const controller = new AbortController();
    activeRequest = controller;
    try {
      const response = await dependencies.fetchPosition(controller.signal);
      if (stopped || controller.signal.aborted || !dependencies.canPoll()) return;
      const decision = decideProviderPoll(response.status, response.body);
      if (decision.kind !== 'position') {
        stopUnavailable();
        return;
      }
      dependencies.onPosition(decision.position);
      scheduleNextPoll();
    } catch {
      if (!controller.signal.aborted && !stopped && dependencies.canPoll()) {
        stopUnavailable();
      }
    } finally {
      if (activeRequest === controller) activeRequest = undefined;
    }
  };

  return {
    sync,
    dispose: () => {
      stopped = true;
      clearScheduledPoll();
      activeRequest?.abort();
    },
  };
}
