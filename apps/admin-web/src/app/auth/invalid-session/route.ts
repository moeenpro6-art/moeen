import { NextResponse } from 'next/server';
import {
  staffSessionCookieName,
  staffSessionCookieOptions,
} from '../session';

export function GET(request: Request): NextResponse {
  const response = NextResponse.redirect(
    new URL('/login?error=session', request.url),
  );
  response.cookies.set(staffSessionCookieName, '', {
    ...staffSessionCookieOptions(process.env.NODE_ENV === 'production'),
    maxAge: 0,
  });
  return response;
}
