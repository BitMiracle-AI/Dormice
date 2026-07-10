import { createFileRoute, redirect } from '@tanstack/react-router';
import { AppShell } from '@/components/AppShell';
import { hasSessionMarker } from '@/lib/session';

/**
 * The gate for everything signed-in, written once — child routes inherit it.
 * The marker is only a hint (the real credential is the httpOnly cookie the
 * page cannot read); a stale "yes" is corrected by the 401 interceptor in
 * api.ts on the first request. What the guard buys is the common case:
 * a signed-out visitor never sees a protected page flash before the
 * redirect, and the deep link they wanted survives the trip through login.
 *
 * The layout is also written once: AppShell renders the sidebar, the top
 * bar and the page Outlet for every signed-in route.
 */
export const Route = createFileRoute('/_app')({
  beforeLoad: ({ location }) => {
    if (!hasSessionMarker()) {
      throw redirect({ to: '/login', search: { redirect: location.href } });
    }
  },
  component: AppShell,
});
