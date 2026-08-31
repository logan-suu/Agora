import type { Message, MsgType } from '@agora/core-domain';

export interface MessageCommitted {
  projectId: string;
  taskId: string;
  message: Message;
}

export interface DisplayMessageEvent {
  msgId: string;
  channelId: string;
  fromRole: string;
  type: MsgType;
  display: string;
  ts: number;
}

export interface MessageBus {
  publish(event: MessageCommitted): Promise<void>;
}

export function toDisplayMessageEvent(event: MessageCommitted): DisplayMessageEvent {
  const { msgId, channelId, fromRole, type, display, ts } = event.message;
  return { msgId, channelId, fromRole, type, display, ts };
}
