import type { ChatDelta } from './chat';

export interface ChatExecution {
  operationId: string; serviceRequestId?: string; responseId?: string;
  startedAt: number; updatedAt: number; finishedAt?: number;
  requestStartedAt?: number;
  phase: 'waiting' | 'reasoning' | 'tools' | 'generating' | 'completed' | 'cancelled' | 'failed';
  firstTokenMs?: number; firstVisibleMs?: number;
}
export const newChatExecution = (operationId: string, startedAt = Date.now()): ChatExecution => ({ operationId, startedAt, updatedAt: startedAt, phase: 'waiting' });
export function advanceChatExecution(execution: ChatExecution, delta: ChatDelta, at = Date.now()): ChatExecution {
  if (execution.finishedAt !== undefined) return execution;
  const next = { ...execution, updatedAt: at };
  if (delta.responseId) next.responseId = delta.responseId;
  if (delta.serviceRequestId) next.serviceRequestId = delta.serviceRequestId;
  if ((delta.content || delta.reasoning) && next.firstTokenMs === undefined && next.requestStartedAt !== undefined) next.firstTokenMs = Math.max(0, at - next.requestStartedAt);
  if (delta.content) { next.phase = 'generating'; if(delta.content.trim()&&next.requestStartedAt!==undefined) next.firstVisibleMs ??= Math.max(0, at - next.requestStartedAt); }
  else if (delta.tool && ['running', 'writing'].includes(delta.tool.status)) next.phase = 'tools';
  else if (delta.reasoning) next.phase = 'reasoning';
  if (delta.error) next.phase = 'failed';
  return next;
}
export function finishChatExecution(execution: ChatExecution, cancelled: boolean, failed: boolean, at = Date.now()): ChatExecution {
  if (execution.finishedAt !== undefined) return execution;
  return { ...execution, updatedAt: at, finishedAt: at, phase: cancelled ? 'cancelled' : failed ? 'failed' : 'completed' };
}
