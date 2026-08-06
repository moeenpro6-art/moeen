'use server';

import { redirect } from 'next/navigation';
import { dashboardApiFetch } from '../auth/api-client';
import {
  clearStaffSessionToken,
  readStaffSessionToken,
} from '../auth/session';

export async function logoutStaffAction(): Promise<void> {
  const token = await readStaffSessionToken();
  if (token) {
    try {
      await dashboardApiFetch('/admin/auth/logout', token, { method: 'POST' });
    } catch {
      // Clearing the local HttpOnly cookie is still required when the API is unavailable.
    }
  }
  await clearStaffSessionToken();
  redirect('/login');
}
