// Domain failures of the control plane; api/problem.ts maps each to one HTTP status.
export class InvalidInputError extends Error {}

export class DomainConflictError extends Error {}

export class NotFoundError extends Error {
  constructor(what = "organization") {
    super(`${what} not found`);
  }
}

export class RoleForbiddenError extends Error {
  constructor() {
    super("an active admin membership is required");
  }
}

export class VersionConflictError extends Error {
  constructor(readonly currentVersion: bigint) {
    super(`membership is at version ${currentVersion}`);
  }
}

export class LastAdminError extends Error {
  constructor() {
    super("the last active admin cannot be demoted or removed");
  }
}

export class InvitationUnusableError extends Error {
  constructor() {
    super("invitation is unknown, expired or already used");
  }
}

export class InvitationEmailMismatchError extends Error {
  constructor() {
    super("invitation was issued to a different verified email");
  }
}

export class IdempotencyConflictError extends Error {
  constructor() {
    super("Idempotency-Key was already used for a different request");
  }
}

export class AmbiguousMembershipError extends Error {
  constructor() {
    super("identity has active memberships in more than one tenant");
  }
}
