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
