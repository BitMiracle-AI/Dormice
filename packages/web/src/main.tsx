import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { LoginPage } from './pages/login';
import { SandboxesPage } from './pages/sandboxes';
import './styles.css';

const rootRoute = createRootRoute({ component: Outlet });

const sandboxesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: SandboxesPage,
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  component: LoginPage,
});

// The daemon serves the console under /ui; the router lives there too so
// server paths and client paths are the same strings everywhere.
const router = createRouter({
  routeTree: rootRoute.addChildren([sandboxesRoute, loginRoute]),
  basepath: '/ui',
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

const queryClient = new QueryClient();

// biome-ignore lint/style/noNonNullAssertion: index.html always has #root
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
