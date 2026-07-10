import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { mintEnvdToken } from '@/lib/api';
import { openPty, type PtySession } from '../envd-pty';
import '@xterm/xterm/css/xterm.css';

/**
 * One live terminal: an xterm bound to a PTY session in the sandbox. The
 * whole session lives inside the effect — unmounting kills the shell, so
 * navigating away never strands a bash in the process table.
 */
function LiveTerminal({ sandboxId }: { sandboxId: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [closedReason, setClosedReason] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: generation is unused inside on purpose — bumping it is how Reconnect re-runs the whole session effect
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const term = new Terminal({ cursorBlink: true, fontSize: 13 });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    fit.fit();
    // Waking a stopped sandbox is a cold start — seconds, not ms. Say so
    // in the terminal itself instead of leaving a dead black box.
    term.writeln('\x1b[2m连接中 — 沉睡的沙箱会先被唤醒…\x1b[0m');

    let session: PtySession | undefined;
    let cancelled = false;
    (async () => {
      const { envdAccessToken } = await mintEnvdToken(sandboxId);
      if (cancelled) return;
      session = await openPty({
        sandboxId,
        envdAccessToken,
        size: { cols: term.cols, rows: term.rows },
        callbacks: {
          onData: (bytes) => term.write(bytes),
          onClose: (reason) => {
            if (!cancelled) setClosedReason(reason);
          },
        },
      });
      if (cancelled) {
        void session.close();
        return;
      }
      term.onData((data) => session?.write(data));
      term.onResize(({ cols, rows }) => session?.resize({ cols, rows }));
      term.focus();
    })().catch((error: unknown) => {
      if (!cancelled) {
        setClosedReason(error instanceof Error ? error.message : String(error));
      }
    });

    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(container);
    return () => {
      cancelled = true;
      observer.disconnect();
      void session?.close();
      term.dispose();
    };
  }, [sandboxId, generation]);

  return (
    <div className="flex flex-col gap-2">
      <div
        ref={containerRef}
        className="h-80 w-full overflow-hidden rounded-md bg-black p-2"
      />
      {closedReason && (
        <div className="flex items-center justify-between rounded-md border px-3 py-2 text-sm text-muted-foreground">
          <span>{closedReason}</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setClosedReason(null);
              setGeneration((n) => n + 1);
            }}
          >
            重新连接
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * The terminal lives behind an explicit click: opening one starts a bash,
 * which wakes a frozen sandbox — and merely looking at a detail page must
 * never thaw anything.
 */
export function SandboxTerminalCard({ sandboxId }: { sandboxId: string }) {
  const [open, setOpen] = useState(false);

  return (
    <Card>
      <CardHeader>
        <CardTitle>终端</CardTitle>
        <CardDescription>
          沙箱里的交互式 bash — 打开会唤醒沉睡的沙箱,关掉后空闲倒计时
          恢复。看这一页本身不会解冻任何东西。
        </CardDescription>
        <CardAction>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setOpen((value) => !value)}
          >
            {open ? '关闭终端' : '打开终端'}
          </Button>
        </CardAction>
      </CardHeader>
      {open && (
        <CardContent>
          <LiveTerminal sandboxId={sandboxId} />
        </CardContent>
      )}
    </Card>
  );
}
