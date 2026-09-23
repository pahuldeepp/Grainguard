export class InvalidTenantError extends Error {
  constructor() {
    super("Tenant identifier must be a lowercase, non-nil UUID");
  }
}

export class LockNotAvailableError extends Error {
  constructor() {
    super("The row is locked by another transaction");
  }
}

interface AdapterFailure {
  meta?: { driverAdapterError?: { cause?: { originalCode?: unknown } } };
}

// Prisma reports its own code (P2002, P2010, ...) at the top level; the SQLSTATE from
// PostgreSQL is carried by the pg driver adapter under meta.driverAdapterError.cause.
export function postgresCode(error: unknown): string | undefined {
  const code = (error as AdapterFailure | undefined)?.meta?.driverAdapterError
    ?.cause?.originalCode;
  return typeof code === "string" ? code : undefined;
}
