import {
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const accessCodeKeyLength = 64;
const accessCodeHashPrefix = 'scrypt';
const legacyTokenHashPattern = /^[a-f0-9]{64}$/i;

/**
 * Generates a provider access code with at least 128 bits of entropy
 * (16 cryptographically secure random bytes encoded as 32 hex characters).
 */
export function generateProviderAccessCode(): string {
  return randomBytes(16).toString('hex');
}

/**
 * Deterministic, indexed lookup identifier for an access code.
 * SHA-256 of a high-entropy code is safe to store as a lookup key; it is
 * never used for verification.
 */
export function providerAccessCodeLookupId(accessCode: string): string {
  return createHash('sha256').update(accessCode).digest('hex');
}

// A structurally valid scrypt hash used to equalize verification timing when
// an unknown lookup id is presented (no real credential is ever verified).
const dummyProviderAccessCodeHash = `scrypt$${'0'.repeat(32)}$${'0'.repeat(
  128,
)}`;

/**
 * Runs one fixed scrypt verification against a dummy hash so that unknown
 * access codes cost the same as a real verification attempt.
 */
export async function verifyDummyProviderAccessCode(): Promise<void> {
  await verifyProviderAccessCode(
    'dummy-provider-access-code-verification',
    dummyProviderAccessCodeHash,
  );
}

export async function hashProviderAccessCode(
  accessCode: string,
): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const derivedKey = (await scrypt(
    accessCode,
    salt,
    accessCodeKeyLength,
  )) as Buffer;
  return `${accessCodeHashPrefix}$${salt}$${derivedKey.toString('hex')}`;
}

export async function verifyProviderAccessCode(
  accessCode: string,
  storedHash: string,
): Promise<boolean> {
  const [prefix, salt, expectedKey] = storedHash.split('$');
  if (
    prefix === accessCodeHashPrefix &&
    salt &&
    expectedKey &&
    /^[a-f0-9]+$/i.test(expectedKey)
  ) {
    const expected = Buffer.from(expectedKey, 'hex');
    const actual = (await scrypt(
      accessCode,
      salt,
      accessCodeKeyLength,
    )) as Buffer;
    return (
      expected.length === actual.length && timingSafeEqual(expected, actual)
    );
  }

  if (!legacyTokenHashPattern.test(storedHash)) return false;
  const expected = Buffer.from(storedHash, 'hex');
  const actual = Buffer.from(
    createHash('sha256').update(accessCode).digest('hex'),
    'hex',
  );
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function isLegacyProviderAccessCodeHash(storedHash: string): boolean {
  return legacyTokenHashPattern.test(storedHash);
}
