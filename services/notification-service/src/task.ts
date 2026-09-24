import { isUuid } from "./tenant.js";

export const CHANNELS = ["email", "sms", "push"] as const;
export type Channel = (typeof CHANNELS)[number];

/** RabbitMQ task body published by jobs-worker (services/jobs-worker/dispatcher.go Task). */
export interface Task {
  intent_id: string;
  tenant_id: string;
  channel: Channel;
  transition: string;
  severity: string;
  alert_id: string;
  episode_id: string;
  transition_version: number;
  delivery_generation: number;
  correlation_id: string;
  traceparent: string;
}

export class InvalidTaskError extends Error {}

const ID_FIELDS = [
  "intent_id",
  "tenant_id",
  "alert_id",
  "episode_id",
  "correlation_id",
] as const;

/** Validates a task; messageId must equal intent_id so broker dedupe and ledger agree. */
export function parseTask(body: Buffer, messageId: string | undefined): Task {
  let value: unknown;
  try {
    value = JSON.parse(body.toString("utf8"));
  } catch {
    throw new InvalidTaskError("task is not JSON");
  }
  const task = value as Task;
  if (typeof value !== "object" || value === null)
    throw new InvalidTaskError("task is not an object");
  for (const field of ID_FIELDS)
    if (!isUuid(task[field]))
      throw new InvalidTaskError(`${field} is not a UUID`);
  if (!CHANNELS.includes(task.channel))
    throw new InvalidTaskError("unknown channel");
  if (typeof task.severity !== "string" || task.severity.length === 0)
    throw new InvalidTaskError("severity missing");
  if (
    !Number.isSafeInteger(task.delivery_generation) ||
    task.delivery_generation < 0
  )
    throw new InvalidTaskError("invalid delivery generation");
  if (messageId !== task.intent_id)
    throw new InvalidTaskError("message id differs from intent_id");
  return task;
}
