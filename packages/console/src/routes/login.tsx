import { createFileRoute, redirect } from '@tanstack/react-router';
import { LoginPage } from '@/features/auth/pages/LoginPage';
import { hasSessionMarker } from '@/lib/session';

/**
 * Open-redirect protection for `?redirect=`: only an in-app absolute path
 * (single leading slash — `//evil.com` is protocol-relative) is honored;
 * anything else is dropped, not rejected — a broken deep link should not
 * break signing in.
 */
export type LoginSearch = { redirect?: string };

export const Route = createFileRoute('/login')({
  validateSearch: (search): LoginSearch => {
    const value = search.redirect;
    return typeof value === 'string' &&
      value.startsWith('/') &&
      !value.startsWith('//')
      ? { redirect: value }
      : {};
  },
  // Reverse guard: someone who is (probably) signed in has no business on
  // the login page — send them to their target, or the sandbox list.
  beforeLoad: ({ search }) => {
    if (!hasSessionMarker()) return;
    if (search.redirect) throw redirect({ href: search.redirect });
    throw redirect({ to: '/' });
  },
  component: LoginPage,
});
