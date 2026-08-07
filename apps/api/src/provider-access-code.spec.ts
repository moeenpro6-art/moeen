import { createHash } from 'node:crypto';
import {
  generateProviderAccessCode,
  hashProviderAccessCode,
  providerAccessCodeLookupId,
  verifyDummyProviderAccessCode,
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

  it('derives a deterministic 64-character hex lookup id from an access code', () => {
    const first = providerAccessCodeLookupId(accessCode);
    const second = providerAccessCodeLookupId(accessCode);

    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(first).toBe(createHash('sha256').update(accessCode).digest('hex'));
    expect(providerAccessCodeLookupId(`${accessCode}-other`)).not.toBe(first);
  });

  it('generates access codes with at least 128 bits of entropy', () => {
    const generated = new Set<string>();
    for (let index = 0; index < 1000; index += 1) {
      const code = generateProviderAccessCode();
      expect(code).toMatch(/^[a-f0-9]{32}$/);
      generated.add(code);
    }
    // 32 hex characters = 128 bits of entropy; 1000 draws must be unique.
    expect(generated.size).toBe(1000);
  });

  it('runs a dummy scrypt verification without touching a real credential', async () => {
    await expect(verifyDummyProviderAccessCode()).resolves.toBeUndefined();
  });
});
