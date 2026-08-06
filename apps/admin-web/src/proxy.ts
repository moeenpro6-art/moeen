import { NextResponse, type NextRequest } from 'next/server';
import { dashboardProxyRedirect } from './app/auth/route-policy';
import { staffSessionCookieName } from './app/auth/session';

export function proxy(request: NextRequest): NextResponse {
  const hasStaffSession = Boolean(
    request.cookies.get(staffSessionCookieName)?.value,
  );
  const redirectPath = dashboardProxyRedirect(
    request.nextUrl.pathname,
    hasStaffSession,
  );
  if (redirectPath) {
    return NextResponse.redirect(new URL(redirectPath, request.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
