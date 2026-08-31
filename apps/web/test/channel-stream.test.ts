import { describe, expect, it, vi } from 'vitest';

import { ChannelStream, encodeSseEvent } from '../src/server/channel-stream';

describe('ChannelStream', () => {
  it('publishes only to subscribers of the selected channel', () => {
    const stream = new ChannelStream();
    const mainListener = vi.fn();
    const subListener = vi.fn();

    stream.subscribe('main', mainListener);
    stream.subscribe('sub-1', subListener);

    const delivered = stream.publish('main', { type: 'message', data: { payload: 'hello' } });

    expect(delivered).toBe(1);
    expect(mainListener).toHaveBeenCalledWith({ type: 'message', data: { payload: 'hello' } });
    expect(subListener).not.toHaveBeenCalled();
  });

  it('removes an empty channel after unsubscribe', () => {
    const stream = new ChannelStream();
    const unsubscribe = stream.subscribe('main', vi.fn());

    expect(stream.subscriberCount('main')).toBe(1);
    unsubscribe();

    expect(stream.subscriberCount('main')).toBe(0);
    expect(stream.channelCount()).toBe(0);
  });
});

describe('encodeSseEvent', () => {
  it('encodes a named event as one SSE frame', () => {
    expect(encodeSseEvent({ type: 'message', data: { payload: 'hello' } })).toBe(
      'event: message\ndata: {"payload":"hello"}\n\n',
    );
  });
});
