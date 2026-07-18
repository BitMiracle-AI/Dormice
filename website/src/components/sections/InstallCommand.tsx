import { CopyButton } from '@/components/sections/CopyButton';
import { cn } from '@/lib/utils';

// The same literal as docs/installation.mdx — the landing page must never
// advertise a command the docs don't stand behind.
const INSTALL_COMMAND =
  'curl -fsSL https://raw.githubusercontent.com/BitMiracle-AI/Dormice/main/deploy/install.sh | bash';

// One-line install prompt, shared by the hero and the closing section so
// the command can never drift between the two.
export function InstallCommand({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        'flex w-full max-w-xl items-center gap-1 rounded-lg border bg-card py-1.5 pr-1.5 pl-4 font-mono text-[13px] shadow-xs',
        className,
      )}
    >
      <span aria-hidden className="select-none text-muted-foreground">
        $
      </span>
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap px-2 py-1">
        {INSTALL_COMMAND}
      </code>
      <CopyButton text={INSTALL_COMMAND} />
    </div>
  );
}
