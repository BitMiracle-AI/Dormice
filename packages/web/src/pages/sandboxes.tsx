import type { Sandbox, SandboxState } from '@dormice/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import {
  listSandboxes,
  logout,
  releaseSandbox,
  UnauthorizedError,
} from '../api';

const STATE_STYLES: Record<SandboxState, string> = {
  active: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  frozen: 'bg-sky-500/15 text-sky-400 border-sky-500/30',
  stopped: 'bg-slate-500/15 text-slate-400 border-slate-500/30',
  archived: 'bg-violet-500/15 text-violet-400 border-violet-500/30',
  restoring: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
};

function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  if (s < 86400)
    return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

function since(iso: string): string {
  return formatDuration((Date.now() - Date.parse(iso)) / 1000);
}

/** The three knobs in one line: how this sandbox cools down when idle. */
function policyLine(policy: Sandbox['policy']): string {
  const step = (label: string, seconds: number | null) =>
    seconds === null ? `${label} never` : `${label} ${formatDuration(seconds)}`;
  return [
    step('freeze', policy.freezeAfterSeconds),
    step('stop', policy.stopAfterSeconds),
    step('archive', policy.archiveAfterSeconds),
  ].join(' · ');
}

function ReleaseButton({ userKey }: { userKey: string }) {
  const queryClient = useQueryClient();
  const [armed, setArmed] = useState(false);
  const mutation = useMutation({
    mutationFn: releaseSandbox,
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['sandboxes'] }),
  });

  // Two clicks on purpose: release destroys the sandbox and its disk, and a
  // modal library is more machinery than one armed state.
  if (!armed) {
    return (
      <button
        type="button"
        onClick={() => setArmed(true)}
        className="rounded-md border border-slate-700 px-3 py-1 text-xs text-slate-300 hover:border-red-500/50 hover:text-red-400"
      >
        Release
      </button>
    );
  }
  return (
    <span className="flex items-center justify-end gap-2">
      <button
        type="button"
        onClick={() => mutation.mutate(userKey)}
        disabled={mutation.isPending}
        className="rounded-md bg-red-600 px-3 py-1 text-xs font-medium text-white hover:bg-red-500 disabled:opacity-50"
      >
        {mutation.isPending ? 'Releasing…' : 'Destroy it'}
      </button>
      <button
        type="button"
        onClick={() => setArmed(false)}
        className="rounded-md border border-slate-700 px-3 py-1 text-xs text-slate-400"
      >
        Keep
      </button>
    </span>
  );
}

export function SandboxesPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['sandboxes'],
    queryFn: listSandboxes,
    // The observation window observes: a short poll against a local SQLite
    // read is effectively free, and 2s is faster than the human eye needs.
    refetchInterval: 2000,
    retry: false,
  });

  useEffect(() => {
    if (query.error instanceof UnauthorizedError) {
      navigate({ to: '/login' });
    }
  }, [query.error, navigate]);

  const logoutMutation = useMutation({
    mutationFn: logout,
    onSuccess: () => {
      queryClient.clear();
      navigate({ to: '/login' });
    },
  });

  const sandboxes = query.data?.sandboxes ?? [];

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      <header className="flex items-center justify-between border-b border-slate-800 px-6 py-4">
        <div className="flex items-baseline gap-3">
          <h1 className="text-lg font-semibold">Dormice</h1>
          <span className="text-sm text-slate-400">
            {sandboxes.length} sandbox{sandboxes.length === 1 ? '' : 'es'}
          </span>
        </div>
        <button
          type="button"
          onClick={() => logoutMutation.mutate()}
          className="rounded-md border border-slate-700 px-3 py-1 text-sm text-slate-300 hover:border-slate-500"
        >
          Sign out
        </button>
      </header>

      <section className="px-6 py-6">
        {query.isError && !(query.error instanceof UnauthorizedError) && (
          <p className="mb-4 rounded-md border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-400">
            {query.error.message}
          </p>
        )}

        {query.isSuccess && sandboxes.length === 0 && (
          <div className="rounded-xl border border-slate-800 bg-slate-900 px-6 py-12 text-center text-slate-400">
            <p className="font-medium text-slate-300">No sandboxes yet</p>
            <p className="mt-2 text-sm">
              Acquire one via the SDK or{' '}
              <code className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-xs">
                POST /acquireSandbox
              </code>{' '}
              — it will appear here within two seconds.
            </p>
          </div>
        )}

        {sandboxes.length > 0 && (
          <div className="overflow-x-auto rounded-xl border border-slate-800">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-800 bg-slate-900 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3">User key</th>
                  <th className="px-4 py-3">State</th>
                  <th className="px-4 py-3">Idle</th>
                  <th className="px-4 py-3">Lifecycle policy</th>
                  <th className="px-4 py-3">Sandbox ID</th>
                  <th className="px-4 py-3">Age</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/70">
                {sandboxes.map((sandbox) => (
                  <tr key={sandbox.sandboxId} className="hover:bg-slate-900/60">
                    <td className="px-4 py-3 font-mono">{sandbox.userKey}</td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-block rounded-full border px-2.5 py-0.5 text-xs font-medium ${STATE_STYLES[sandbox.state]}`}
                      >
                        {sandbox.state}
                      </span>
                    </td>
                    <td className="px-4 py-3 tabular-nums text-slate-400">
                      {since(sandbox.lastActiveAt)}
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-400">
                      {policyLine(sandbox.policy)}
                    </td>
                    <td
                      className="max-w-40 truncate px-4 py-3 font-mono text-xs text-slate-500"
                      title={sandbox.sandboxId}
                    >
                      {sandbox.sandboxId}
                    </td>
                    <td className="px-4 py-3 tabular-nums text-slate-400">
                      {since(sandbox.createdAt)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <ReleaseButton userKey={sandbox.userKey} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
