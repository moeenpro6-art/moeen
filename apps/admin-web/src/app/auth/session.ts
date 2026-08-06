import { cookies } from 'next/headers';

export type StaffRole = 'admin' | 'dispatcher' | 'support_agent';

export type StaffProfile = {
  id: string;
  email: string;
  displayName: string;
  role: StaffRole;
};

export const staffSessionCookieName =
  process.env.MOEEN_DASHBOARD_SESSION_COOKIE ?? 'moeen_staff_session';
const sessionMaxAgeSeconds = 60 * 60 * 24 * 7;

export function staffSessionCookieOptions(isProduction: boolean) {
  return {
    httpOnly: true,
    sameSite: 'strict' as const,
    secure: isProduction,
    path: '/',
    maxAge: sessionMaxAgeSeconds,
  };
}

export function toStaffProfile(value: unknown): StaffProfile | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  const role = candidate.role;
  if (
    typeof candidate.id !== 'string' ||
    typeof candidate.email !== 'string' ||
    typeof candidate.displayName !== 'string' ||
    !['admin', 'dispatcher', 'support_agent'].includes(String(role))
  ) {
    return undefined;
  }
  return {
    id: candidate.id,
    email: candidate.email,
    displayName: candidate.displayName,
    role: role as StaffRole,
  };
}

export async function readStaffSessionToken(): Promise<string | undefined> {
  return (await cookies()).get(staffSessionCookieName)?.value;
}

export async function writeStaffSessionToken(token: string): Promise<void> {
  (await cookies()).set(
    staffSessionCookieName,
    token,
    staffSessionCookieOptions(process.env.NODE_ENV === 'production'),
  );
}

export async function clearStaffSessionToken(): Promise<void> {
  (await cookies()).delete(staffSessionCookieName);
}
