export interface ChannelEvent {
  type: 'connected' | 'snapshot' | 'message' | 'command';
  data: unknown;
}

export interface ChannelAddress {
  projectId: string;
  taskId: string;
  channelId: string;
}

type ChannelListener = (event: ChannelEvent) => void;

export class ChannelStream {
  readonly #subscribers = new Map<string, Set<ChannelListener>>();

  subscribe(address: ChannelAddress, listener: ChannelListener): () => void {
    const key = channelAddressKey(address);
    const listeners = this.#subscribers.get(key) ?? new Set<ChannelListener>();
    listeners.add(listener);
    this.#subscribers.set(key, listeners);

    let active = true;
    return () => {
      if (!active) {
        return;
      }
      active = false;
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.#subscribers.delete(key);
      }
    };
  }

  publish(address: ChannelAddress, event: ChannelEvent): number {
    const listeners = this.#subscribers.get(channelAddressKey(address));
    if (!listeners) {
      return 0;
    }

    for (const listener of listeners) {
      listener(event);
    }
    return listeners.size;
  }

  subscriberCount(address: ChannelAddress): number {
    return this.#subscribers.get(channelAddressKey(address))?.size ?? 0;
  }

  channelCount(): number {
    return this.#subscribers.size;
  }

  clear(): void {
    this.#subscribers.clear();
  }
}

function channelAddressKey(address: ChannelAddress): string {
  return `${address.projectId}\u0000${address.taskId}\u0000${address.channelId}`;
}

export function encodeSseEvent(event: ChannelEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

export const channelStream = new ChannelStream();
