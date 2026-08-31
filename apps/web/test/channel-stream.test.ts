import { describe, expect, it, vi } from 'vitest';

import { ChannelStream, encodeSseEvent } from '../src/server/channel-stream';

describe('ChannelStream', () => {
  it('publishes only to subscribers of the selected task channel', () => {
    const stream = new ChannelStream();
    const mainListener = vi.fn();
    const otherTaskListener = vi.fn();
    const address = { projectId: 'project-a', taskId: 'task-a', channelId: 'main' };

    stream.subscribe(address, mainListener);
    stream.subscribe({ ...address, taskId: 'task-b' }, otherTaskListener);

    const delivered = stream.publish(address, { type: 'message', data: { display: 'hello' } });

    expect(delivered).toBe(1);
    expect(mainListener).toHaveBeenCalledWith({ type: 'message', data: { display: 'hello' } });
    expect(otherTaskListener).not.toHaveBeenCalled();
  });

  it('removes an empty channel after unsubscribe', () => {
    const stream = new ChannelStream();
    const address = { projectId: 'project-a', taskId: 'task-a', channelId: 'main' };
    const unsubscribe = stream.subscribe(address, vi.fn());

    expect(stream.subscriberCount(address)).toBe(1);
    unsubscribe();

    expect(stream.subscriberCount(address)).toBe(0);
    expect(stream.channelCount()).toBe(0);
  });
});

describe('encodeSseEvent', () => {
  it('encodes a named event as one SSE frame', () => {
    expect(encodeSseEvent({ type: 'message', data: { display: 'hello' } })).toBe(
      'event: message\ndata: {"display":"hello"}\n\n',
    );
  });
});
