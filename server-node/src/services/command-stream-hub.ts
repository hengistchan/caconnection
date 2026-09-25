/**
 * In-process fan-out for the device command stream (ADR-003).
 *
 * The stream is advisory only: it carries a "commands are queued" nudge, never
 * command content. Claim/lease in OutboundRepository stays the single
 * correctness and delivery-arbitration point. A lost or duplicated nudge costs
 * at most one empty claim — never a lost or double-sent SMS.
 */

export interface CommandQueuedEvent {
  deviceId: string;
  queuedAt: number;
  pending: number;
}

export type CommandQueuedListener = (event: CommandQueuedEvent) => void;

export class CommandStreamHub {
  private readonly listeners = new Map<string, Set<CommandQueuedListener>>();
  private readonly streamClosers = new Set<() => void>();

  /**
   * Register interest in a device's command queue. The returned function
   * unsubscribes and is idempotent — stream cleanup paths may call it twice.
   */
  subscribe(deviceId: string, listener: CommandQueuedListener): () => void {
    let deviceListeners = this.listeners.get(deviceId);
    if (!deviceListeners) {
      deviceListeners = new Set();
      this.listeners.set(deviceId, deviceListeners);
    }
    deviceListeners.add(listener);

    let unsubscribed = false;
    return () => {
      if (unsubscribed) return;
      unsubscribed = true;
      const current = this.listeners.get(deviceId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.listeners.delete(deviceId);
    };
  }

  /**
   * Nudge every connected stream for [deviceId]. A throwing or broken
   * subscriber must never block the others (one wedged socket would
   * otherwise stall command delivery for every other gateway).
   */
  notifyQueued(event: CommandQueuedEvent): void {
    const deviceListeners = this.listeners.get(event.deviceId);
    if (!deviceListeners || deviceListeners.size === 0) return;
    for (const listener of [...deviceListeners]) {
      try {
        listener(event);
      } catch {
        // The stream's own cleanup unsubscribes; nothing else to do here.
      }
    }
  }

  listenerCount(deviceId?: string): number {
    if (deviceId !== undefined) return this.listeners.get(deviceId)?.size ?? 0;
    let total = 0;
    for (const deviceListeners of this.listeners.values()) total += deviceListeners.size;
    return total;
  }

  /**
   * Track a live stream socket so shutdown can end it. A hijacked SSE
   * response keeps its connection open forever; without forced teardown
   * app.close() would wait on every connected gateway.
   */
  attachStream(closeStream: () => void): () => void {
    this.streamClosers.add(closeStream);
    let detached = false;
    return () => {
      if (detached) return;
      detached = true;
      this.streamClosers.delete(closeStream);
    };
  }

  closeStreams(): void {
    for (const closeStream of [...this.streamClosers]) {
      this.streamClosers.delete(closeStream);
      try {
        closeStream();
      } catch {
        // Already gone — teardown is best effort.
      }
    }
  }
}
