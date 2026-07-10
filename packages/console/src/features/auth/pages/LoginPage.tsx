import { useMutation } from '@tanstack/react-query';
import { useSearch } from '@tanstack/react-router';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Field, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { login } from '@/lib/api';
import { setSessionMarker } from '@/lib/session';

/**
 * One field, one button. The token is posted once and comes back as an
 * httpOnly session cookie — it is never stored anywhere the page can read.
 * Success does a full-page jump (not a client-side navigate): the cookie is
 * brand new, and a reload guarantees every query starts from it.
 */
export function LoginPage() {
  const { redirect } = useSearch({ from: '/login' });
  const [token, setToken] = useState('');
  const mutation = useMutation({
    mutationFn: login,
    onSuccess: () => {
      setSessionMarker();
      window.location.href = redirect ?? '/console/';
    },
  });

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-2xl">Dormice</CardTitle>
          <CardDescription>
            Paste the daemon's API token to open the console.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              mutation.mutate(token);
            }}
            className="flex flex-col gap-6"
          >
            <Field data-invalid={mutation.isError || undefined}>
              <FieldLabel htmlFor="api-token">API token</FieldLabel>
              <Input
                id="api-token"
                type="password"
                autoFocus
                value={token}
                onChange={(event) => setToken(event.target.value)}
                placeholder="DORMICE_API_TOKEN"
                className="font-mono"
                aria-invalid={mutation.isError || undefined}
              />
              {mutation.isError && (
                <FieldError>{mutation.error.message}</FieldError>
              )}
            </Field>
            <Button
              type="submit"
              disabled={token.length === 0 || mutation.isPending}
              className="w-full"
            >
              {mutation.isPending && <Spinner />}
              Sign in
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
