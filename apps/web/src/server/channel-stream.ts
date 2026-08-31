export interface ChannelEvent {
  type: 'connected' | 'message' | 'command';
  data: unknown;
}

type ChannelListener = (event: ChannelEvent) => void;

export class ChannelStream {
  readonly #subscribers = new Map<string, Set<ChannelListener>>();

  subscribe(channelId: string, listener: ChannelListener): () => void {
    const listeners = this.#subscribers.get(channelId) ?? new Set<ChannelListener>();
    listeners.add(listener);
    this.#subscribers.set(channelId, listeners);

    let active = true;
    return () => {
      if (!active) {
        return;
      }
      active = false;
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.#subscribers.delete(channelId);
      }
    };
  }

  publish(channelId: string, event: ChannelEvent): number {
    const listeners = this.#subscribers.get(channelId);
    if (!listeners) {
      return 0;
    }

    for (const listener of listeners) {
      listener(event);
    }
    return listeners.size;
  }

  subscriberCount(channelId: string): number {
    return this.#subscribers.get(channelId)?.size ?? 0;
  }

  channelCount(): number {
    return this.#subscribers.size;
  }

  clear(): void {
    this.#subscribers.clear();
  }
}

export function encodeSseEvent(event: ChannelEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

export const channelStream = new ChannelStream();
