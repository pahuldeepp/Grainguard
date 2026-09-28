import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// Stored as 12-byte nonce || 16-byte GCM tag || ciphertext. No plaintext webhook
// payload is logged or stored. Rotation of this key needs an offline re-encryption
// runbook; Stripe signing-secret rotation is independent.
export function seal(raw: Buffer, key: Buffer): Buffer {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(raw), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
}

export function open(sealed: Buffer, key: Buffer): Buffer {
  if (sealed.length < 28) throw new Error("invalid encrypted inbox payload");
  const decipher = createDecipheriv("aes-256-gcm", key, sealed.subarray(0, 12));
  decipher.setAuthTag(sealed.subarray(12, 28));
  return Buffer.concat([decipher.update(sealed.subarray(28)), decipher.final()]);
}
