export function dashboardProxyRedirect(
  pathname: string,
  hasStaffSession: boolean,
): '/login' | undefined {
  if (pathname === '/' && !hasStaffSession) return '/login';
  return undefined;
}
