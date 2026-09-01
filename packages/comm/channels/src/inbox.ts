import type { AppState, Message, ParticipantId } from '@agora/core-domain';

import type { ProjectChannelSnapshot } from './base';

export interface InboxItem {
  message: Message;
  priority: 'direct' | 'normal';
}

export interface ChannelInbox {
  inboxFor(project: ProjectChannelSnapshot, task: AppState, role: ParticipantId): InboxItem[];
}

export class DerivedChannelInbox implements ChannelInbox {
  inboxFor(project: ProjectChannelSnapshot, task: AppState, role: ParticipantId): InboxItem[] {
    if (project.projectId !== task.projectId) {
      throw new Error(
        `project identity mismatch: channel snapshot is "${project.projectId}" but task is "${task.projectId}"`,
      );
    }

    const visibleChannels = new Set(
      project.channels
        .filter(
          (channel) =>
            channel.participants.includes(role) &&
            (channel.kind === 'main' || channel.taskId === task.taskId),
        )
        .map((channel) => channel.channelId),
    );

    return task.messages.flatMap((message) => {
      if (!visibleChannels.has(message.channelId)) return [];
      return [
        {
          message: structuredClone(message),
          priority: message.to?.includes(role) ? 'direct' : 'normal',
        },
      ];
    });
  }
}
