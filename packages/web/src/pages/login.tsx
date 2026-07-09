import { useMutation } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { login } from '../api';

/**
 * One field, one button. The token is posted once and comes back as an
 * httpOnly session cookie — it is never stored anywhere the page can read.
 */
export function LoginPage() {
  const navigate = useNavigate();
  const [token, setToken] = useState('');
  const mutation = useMutation({
    mutationFn: login,
    onSuccess: () => navigate({ to: '/' }),
  });

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 text-slate-100">
      <form
        className="w-full max-w-sm rounded-xl border border-slate-800 bg-slate-900 p-8 shadow-lg"
        onSubmit={(event) => {
          event.preventDefault();
          mutation.mutate(token);
        }}
      >
        <h1 className="text-2xl font-semibold">Dormice</h1>
        <p className="mt-1 text-sm text-slate-400">
          Paste the daemon's API token to open the console.
        </p>
        <input
          type="password"
          // biome-ignore lint/a11y/noAutofocus: the page has exactly one input and exists only to receive it
          autoFocus
          value={token}
          onChange={(event) => setToken(event.target.value)}
          placeholder="DORMICE_API_TOKEN"
          className="mt-6 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-sm placeholder:text-slate-600 focus:border-sky-500 focus:outline-none"
        />
        {mutation.isError && (
          <p className="mt-3 text-sm text-red-400">{mutation.error.message}</p>
        )}
        <button
          type="submit"
          disabled={token.length === 0 || mutation.isPending}
          className="mt-6 w-full rounded-md bg-sky-600 py-2 font-medium text-white hover:bg-sky-500 disabled:opacity-50"
        >
          {mutation.isPending ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}
