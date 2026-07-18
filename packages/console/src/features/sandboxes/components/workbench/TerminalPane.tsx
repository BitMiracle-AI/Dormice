import type { Sandbox } from '@dormice/shared';
import { ComputerTerminal01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { mintEnvdToken } from '@/lib/api';
import { openPty, type PtySession } from '../../envd-pty';
import '@xterm/xterm/css/xterm.css';

/**
 * One live terminal: an xterm bound to a PTY session in the sandbox. The
 * whole session lives inside the effect — unmounting kills the shell, so
 * navigating away never strands a bash in the process table. The container
 * fills its pane; the ResizeObserver refits on pane drag.
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
    term.writeln('\x1b[2m连接中 — 沉睡的沙箱会先被唤醒\x1b[0m');

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
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div
        ref={containerRef}
        // select-text:全局 select-none 下终端输出必须仍可选中复制。
        className="min-h-0 w-full flex-1 select-text overflow-hidden rounded-md bg-black p-2"
      />
      {closedReason && (
        <div className="flex shrink-0 items-center justify-between rounded-md border px-3 py-2 text-sm text-muted-foreground">
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
 * 工作台的终端窗格。shell 活在显式点击后面:打开 bash 会唤醒冻结的
 * 沙箱、重置空闲计时 — 所以哪怕沙箱正 active 也不偷跑,"看工作台"
 * 绝不解冻、绝不续命。断开 = 卸载 LiveTerminal(effect cleanup 杀 shell,
 * 不在进程表留孤儿)。
 */
export function TerminalPane({ sandbox }: { sandbox: Sandbox }) {
  const [connected, setConnected] = useState(false);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-1.5">
        <span className="text-sm font-medium">终端</span>
        <div className="flex items-center gap-2">
          <span className="hidden text-xs text-muted-foreground sm:inline">
            打开会唤醒沉睡的沙箱,关掉后空闲倒计时恢复
          </span>
          <Button
            variant="outline"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() => setConnected((value) => !value)}
          >
            {connected ? '断开' : '连接终端'}
          </Button>
        </div>
      </div>
      {connected ? (
        <div className="min-h-0 flex-1 p-2">
          <LiveTerminal sandboxId={sandbox.id} />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center p-4">
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <HugeiconsIcon icon={ComputerTerminal01Icon} />
              </EmptyMedia>
              <EmptyTitle>沙箱里的交互式 bash</EmptyTitle>
              <EmptyDescription>
                连接会唤醒沉睡的沙箱 — 看工作台本身不会解冻任何东西。
              </EmptyDescription>
            </EmptyHeader>
            <Button size="sm" onClick={() => setConnected(true)}>
              连接终端
            </Button>
          </Empty>
        </div>
      )}
    </div>
  );
}
