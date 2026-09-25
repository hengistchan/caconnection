import { describe, expect, it } from 'vitest';
import {
  CommandStreamHub,
  type CommandQueuedEvent,
} from '../../src/services/command-stream-hub.js';

const event: CommandQueuedEvent = {
  deviceId: 'device-a',
  queuedAt: 1_700_000_000_000,
  pending: 1,
};

describe('CommandStreamHub', () => {
  it('delivers nudges only to the targeted device', () => {
    const hub = new CommandStreamHub();
    const seenA: CommandQueuedEvent[] = [];
    const seenB: CommandQueuedEvent[] = [];
    hub.subscribe('device-a', e => seenA.push(e));
    hub.subscribe('device-b', e => seenB.push(e));

    hub.notifyQueued(event);

    expect(seenA).toEqual([event]);
    expect(seenB).toEqual([]);
  });

  it('stops delivering after unsubscribe and tolerates double unsubscribe', () => {
    const hub = new CommandStreamHub();
    const seen: CommandQueuedEvent[] = [];
    const unsubscribe = hub.subscribe('device-a', e => seen.push(e));

    hub.notifyQueued(event);
    unsubscribe();
    unsubscribe();
    hub.notifyQueued(event);

    expect(seen).toEqual([event]);
    expect(hub.listenerCount('device-a')).toBe(0);
    expect(hub.listenerCount()).toBe(0);
  });

  it('keeps delivering to healthy listeners when one throws', () => {
    const hub = new CommandStreamHub();
    const seen: CommandQueuedEvent[] = [];
    hub.subscribe('device-a', () => {
      throw new Error('wedged socket');
    });
    hub.subscribe('device-a', e => seen.push(e));

    hub.notifyQueued(event);

    expect(seen).toEqual([event]);
    expect(hub.listenerCount('device-a')).toBe(2);
  });

  it('closes every stream on shutdown and detaches cleanly', () => {
    const hub = new CommandStreamHub();
    let closed = 0;
    const detach = hub.attachStream(() => {
      closed += 1;
    });

    hub.closeStreams();
    hub.closeStreams();
    detach();
    detach();

    expect(closed).toBe(1);
    expect(hub.listenerCount()).toBe(0);
  });
});
