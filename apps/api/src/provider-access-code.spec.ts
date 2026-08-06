import { createHash } from 'node:crypto';
import {
  hashProviderAccessCode,
  verifyProviderAccessCode,
} from './provider-access-code';

describe('provider access-code hashing', () => {
  const accessCode = 'provider-access-code-for-security-tests';

  it('stores a salted slow hash that verifies only the original access code', async () => {
    const hash = await hashProviderAccessCode(accessCode);

    expect(hash).toMatch(/^scrypt\$[a-f0-9]+\$[a-f0-9]+$/);
    expect(hash).not.toContain(accessCode);
    await expect(verifyProviderAccessCode(accessCode, hash)).resolves.toBe(
      true,
    );
    await expect(
      verifyProviderAccessCode('wrong-provider-access-code', hash),
    ).resolves.toBe(false);
  });

  it('accepts a legacy token hash once so existing provider access can migrate safely', async () => {
    const legacyHash = createHash('sha256').update(accessCode).digest('hex');

    await expect(
      verifyProviderAccessCode(accessCode, legacyHash),
    ).resolves.toBe(true);
  });
});
