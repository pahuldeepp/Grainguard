export class IdempotencyConflictError extends Error {
  constructor() {
    super("Idempotency key was already used with a different request");
  }
}

export class DuplicateSerialError extends Error {
  constructor() {
    super("A device with this serial number already exists");
  }
}

export class DuplicateBinError extends Error {
  constructor() {
    super("A bin with this identifier already exists");
  }
}

export class InvalidReferenceError extends Error {
  constructor() {
    super("Referenced site or bin does not exist for this tenant and site");
  }
}

export class InvalidInputError extends Error {}

export class DeviceNotFoundError extends Error {
  constructor() {
    super("Device not found");
  }
}

export class VersionConflictError extends Error {
  constructor(readonly currentVersion: string) {
    super("Device was changed by another request");
  }
}

export class DeviceLookupAmbiguousError extends Error {}
