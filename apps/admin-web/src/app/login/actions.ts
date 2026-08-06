'use server';

import { redirect } from 'next/navigation';
import {
  dashboardApiBaseUrl,
  toStaffLogin,
} from '../auth/api-client';
import { writeStaffSessionToken } from '../auth/session';
import { readLoginFields } from './credentials';

export async function loginStaffAction(formData: FormData): Promise<void> {
  const fields = readLoginFields(formData);
  if (!fields) redirect('/login?error=credentials');

  let response: Response;
  try {
    response = await fetch(`${dashboardApiBaseUrl}/admin/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fields),
      cache: 'no-store',
    });
  } catch {
    redirect('/login?error=service');
  }

  if (!response.ok) redirect('/login?error=credentials');
  const login = toStaffLogin(await response.json());
  if (!login) redirect('/login?error=service');

  await writeStaffSessionToken(login.token);
  redirect('/');
}
