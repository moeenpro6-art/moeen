import { redirect } from 'next/navigation';
import { resolveDashboardApiBaseUrl } from './api-url';
import {
  readStaffSessionToken,
  toStaffProfile,
  type StaffProfile,
} from './session';

export const dashboardApiBaseUrl = resolveDashboardApiBaseUrl();

export type StaffLogin = {
  token: string;
  staff: StaffProfile;
};

export function apiAuthorizationHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

export function toStaffLogin(value: unknown): StaffLogin | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.token !== 'string' || !candidate.token) return undefined;
  const staff = toStaffProfile(candidate.staff);
  return staff ? { token: candidate.token, staff } : undefined;
}

export function staffActionFailureRedirect(
  status: number,
): '/auth/invalid-session' | '/?error=forbidden' | undefined {
  if (status === 401) return '/auth/invalid-session';
  if (status === 403) return '/?error=forbidden';
  return undefined;
}

export function staffSessionFailureRedirect(
  status: number,
): '/auth/invalid-session' | '/login?error=service' {
  return status === 401 ? '/auth/invalid-session' : '/login?error=service';
}

export async function dashboardApiFetch(
  path: string,
  token: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  return fetch(`${dashboardApiBaseUrl}${path}`, {
    ...init,
    headers,
    cache: 'no-store',
  });
}

export async function requireStaffSession(): Promise<StaffLogin> {
  const token = await readStaffSessionToken();
  if (!token) redirect('/login');

  let response: Response;
  try {
    response = await dashboardApiFetch('/admin/auth/me', token);
  } catch {
    redirect('/login?error=service');
  }

  if (!response.ok) redirect(staffSessionFailureRedirect(response.status));

  try {
    const staff = toStaffProfile(await response.json());
    if (!staff) redirect('/auth/invalid-session');
    return { token, staff };
  } catch {
    redirect('/auth/invalid-session');
  }
}
