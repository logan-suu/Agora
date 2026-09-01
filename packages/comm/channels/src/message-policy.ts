import type { Channel, Message, ParticipantId } from '@agora/core-domain';

import type { ProjectChannelSnapshot } from './base';

export function assertMessageChannelAccess(
  project: ProjectChannelSnapshot,
  taskId: string,
  message: Message,
): void {
  const channel = resolveParticipantChannel(project, taskId, message.fromRole, message.channelId);
  if (channel.closed) {
    throw new Error(`channel "${channel.channelId}" is closed`);
  }
}

export function resolveParticipantChannel(
  project: ProjectChannelSnapshot,
  taskId: string,
  participant: ParticipantId,
  channelId: string,
): Channel {
  const channel = project.channels.find((candidate) => candidate.channelId === channelId);
  if (channel === undefined) {
    throw new Error(`channel "${channelId}" does not exist in project "${project.projectId}"`);
  }
  if (channel.kind === 'sub' && channel.taskId !== taskId) {
    throw new Error(
      `channel "${channel.channelId}" is bound to taskId "${channel.taskId}", not "${taskId}"`,
    );
  }
  if (!channel.participants.includes(participant)) {
    throw new Error(
      `sender "${participant}" is not a participant of channel "${channel.channelId}"`,
    );
  }
  return structuredClone(channel);
}
