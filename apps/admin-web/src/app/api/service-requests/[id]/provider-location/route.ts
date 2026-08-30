import { dashboardApiBaseUrl } from '../../../../auth/api-client';
import { readStaffSessionToken } from '../../../../auth/session';

type ProviderLocationRouteContext = {
  params: Promise<{ id: string }>;
};

type ProviderLocationRouteDependencies = {
  apiBaseUrl: string;
  readToken: () => Promise<string | undefined>;
  fetchUpstream: (
    input: string,
    init: RequestInit,
  ) => Promise<Response>;
};

type ProviderLocationGetHandler = (
  request: Request,
  context: ProviderLocationRouteContext,
) => Promise<Response>;

/**
 * Builds the server-only operations proxy. Dependency injection keeps the
 * HttpOnly-cookie boundary and upstream failure behavior directly testable.
 */
export function createProviderLocationGetHandler(
  dependencies: ProviderLocationRouteDependencies,
): ProviderLocationGetHandler {
  return async (_request, { params }) => {
    const { id } = await params;
    const token = await dependencies.readToken();
    if (!token) return Response.json({}, { status: 401 });

    let upstream: Response;
    try {
      upstream = await dependencies.fetchUpstream(
        `${dependencies.apiBaseUrl}/service-requests/${encodeURIComponent(id)}/provider-location`,
        {
          headers: { Authorization: `Bearer ${token}` },
          cache: 'no-store',
        },
      );
    } catch {
      return Response.json({}, { status: 502 });
    }

    const body = await upstream.text();
    return new Response(body, {
      status: upstream.status,
      headers: {
        'content-type':
          upstream.headers.get('content-type') ??
          'application/json; charset=utf-8',
      },
    });
  };
}

/**
 * Server-side proxy for the operations provider-position read. The staff
 * session token lives only in an HttpOnly cookie and is never exposed to the
 * browser; the client component polls this route and the server forwards the
 * cookie-authenticated request to the API.
 */
export const GET = createProviderLocationGetHandler({
  apiBaseUrl: dashboardApiBaseUrl,
  readToken: readStaffSessionToken,
  fetchUpstream: (input, init) => fetch(input, init),
});
