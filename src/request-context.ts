import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

// Correlation only: no headers, credentials, command text or file contents.
export const requestContext = new AsyncLocalStorage<{ requestId: string }>();
export const SERVER_INSTANCE_ID = randomUUID();
