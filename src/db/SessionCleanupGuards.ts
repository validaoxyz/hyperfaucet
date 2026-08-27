import type { FaucetDatabase, SessionCleanupCandidate } from "./FaucetDatabase.js";

export type DefaultSessionCleanupGuard = (
  database: FaucetDatabase,
  candidate: SessionCleanupCandidate,
) => boolean | Promise<boolean>;

const defaultSessionCleanupGuards = new Map<string, DefaultSessionCleanupGuard>();

export function registerDefaultSessionCleanupGuard(owner: string, guard: DefaultSessionCleanupGuard): void {
  if(!owner || typeof guard !== "function")
    throw new Error("A default session cleanup guard requires an owner and callback.");
  defaultSessionCleanupGuards.set(owner, guard);
}

export function getDefaultSessionCleanupGuards(): ReadonlyMap<string, DefaultSessionCleanupGuard> {
  return defaultSessionCleanupGuards;
}
