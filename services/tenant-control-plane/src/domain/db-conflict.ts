// Prisma wraps raw PostgreSQL errors as P2010 with meta.code; adapter errors
// may expose SQLSTATE directly. Never infer a conflict from an error message.
export function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as {
    code?: unknown;
    meta?: {
      code?: unknown;
      driverAdapterError?: { cause?: { originalCode?: unknown } };
    };
    cause?: unknown;
  };
  return (
    value.code === "23505" ||
    value.code === "P2002" ||
    (value.code === "P2010" && value.meta?.code === "23505") ||
    (value.code === "P2010" &&
      value.meta?.driverAdapterError?.cause?.originalCode === "23505") ||
    (value.cause !== error && isUniqueViolation(value.cause))
  );
}
