import type { GetUpgradeStatusResponse, UpgradeRun } from '@dormice/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/spinner';
import { ApiError, applyUpgrade, getUpgradeStatus } from '@/lib/api';

/**
 * 一键升级的两幕:确认(把会发生什么说全 — 包括 daemon 重启会打断
 * 进行中的终端/exec/watch,以及构建失败自动回退)→ 观察(2 秒轮询
 * getUpgradeStatus,实时滚日志)。轮询不用查询库而是自己的 setTimeout
 * 链:daemon 重启造成的失联是升级的预期环节,要显示「重启中」继续等,
 * 而不是当错误处理。终局以 install.sh 写下的报告为准 — succeeded 意味
 * 着 daemon 已带着新版本回来并通过 doctor,不是"脚本跑完了"。
 *
 * 防「上一次的旧报告」误判:观察态先要见过进行中(unit 活着或报告说
 * running)才接受终局 — applyUpgrade 刚返回时状态文件可能还是上一轮的。
 */
interface UpgradeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 打开时升级已在跑(上次没看完/别处发起)— 跳过确认直接观察。 */
  alreadyRunning: boolean;
}

export function UpgradeDialog({
  open,
  onOpenChange,
  alreadyRunning,
}: UpgradeDialogProps) {
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<'confirm' | 'watch'>('confirm');
  const [launching, setLaunching] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<GetUpgradeStatusResponse | null>(
    null,
  );
  const [unreachable, setUnreachable] = useState(false);
  const [outcome, setOutcome] = useState<UpgradeRun | null>(null);
  const sawProgress = useRef(false);

  // 每次打开都是一场新的升级:上一场的快照与终局不许串场。
  useEffect(() => {
    if (!open) return;
    setPhase(alreadyRunning ? 'watch' : 'confirm');
    setLaunching(false);
    setLaunchError(null);
    setSnapshot(null);
    setUnreachable(false);
    setOutcome(null);
    sawProgress.current = alreadyRunning;
  }, [open, alreadyRunning]);

  useEffect(() => {
    if (!open || phase !== 'watch' || outcome !== null) return;
    let stopped = false;
    let timer: number | undefined;
    const tick = async () => {
      try {
        const status = await getUpgradeStatus();
        if (stopped) return;
        setUnreachable(false);
        setSnapshot(status);
        if (status.running || status.last?.state === 'running') {
          sawProgress.current = true;
        } else if (sawProgress.current && status.last !== null) {
          setOutcome(status.last);
          // 成功后重新问一次版本(新 daemon 的缓存是空的,会真查一次
          // 并显示已是最新);无论成败,执行窗与配置都过期了。
          queryClient.invalidateQueries({ queryKey: ['checkUpgrade'] });
          queryClient.invalidateQueries({ queryKey: ['upgradeStatus'] });
          queryClient.invalidateQueries({ queryKey: ['config'] });
          return;
        }
      } catch {
        if (stopped) return;
        // 失联 = daemon 大概率在重启,升级本身在 systemd unit 里继续。
        setUnreachable(true);
      }
      timer = window.setTimeout(tick, 2000);
    };
    tick();
    return () => {
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [open, phase, outcome, queryClient]);

  // 日志跟到底部 — 观察窗要像 tail -f。
  const logRef = useRef<HTMLPreElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 滚动跟随日志内容
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [snapshot?.log]);

  const start = async () => {
    setLaunching(true);
    setLaunchError(null);
    try {
      await applyUpgrade();
      sawProgress.current = false;
      setPhase('watch');
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        // 已经有一场在跑 — 那就看它。
        sawProgress.current = true;
        setPhase('watch');
      } else {
        setLaunchError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      setLaunching(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        {phase === 'confirm' ? (
          <>
            <DialogHeader>
              <DialogTitle>升级 Dormice</DialogTitle>
              <DialogDescription>
                在这台服务器上重跑 install.sh(重跑即升级),全程约几分钟。
              </DialogDescription>
            </DialogHeader>
            <ol className="list-decimal space-y-1.5 pl-5 text-sm">
              <li>拉取最新代码并重新构建,耗时取决于服务器网络。</li>
              <li>
                构建成功后 daemon 重启:
                <span className="text-foreground font-medium">
                  进行中的终端、命令执行、文件监听会断开
                </span>
                ;沙箱与磁盘不受影响,对账器会接管现场。
              </li>
              <li>
                构建失败会自动回退到当前版本重新构建,daemon 不重启, 照常服务。
              </li>
              <li>重启期间控制台会短暂失联,这个弹窗会等它带着新版本回来。</li>
            </ol>
            {launchError !== null && (
              <p className="text-sm text-destructive">
                无法发起升级:{launchError}
              </p>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                取消
              </Button>
              <Button disabled={launching} onClick={start}>
                {launching && <Spinner />}
                开始升级
              </Button>
            </DialogFooter>
          </>
        ) : (
          <WatchBody
            outcome={outcome}
            unreachable={unreachable}
            log={snapshot?.log ?? null}
            logRef={logRef}
            onClose={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function WatchBody({
  outcome,
  unreachable,
  log,
  logRef,
  onClose,
}: {
  outcome: UpgradeRun | null;
  unreachable: boolean;
  log: string | null;
  logRef: React.RefObject<HTMLPreElement | null>;
  onClose: () => void;
}) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {outcome === null
            ? '升级进行中'
            : outcome.state === 'succeeded'
              ? '升级完成'
              : outcome.state === 'rolled-back'
                ? '升级失败,已自动回退'
                : '升级失败'}
        </DialogTitle>
        <DialogDescription>
          {outcome === null ? (
            unreachable ? (
              'daemon 正在重启,短暂失联是升级的预期环节;正在等它回来。' +
              '如果长时间停在这里,ssh 上去看 journalctl -u dormice-upgrade。'
            ) : (
              '升级在服务器的 systemd unit 里执行,关掉弹窗也不会中断。'
            )
          ) : outcome.state === 'succeeded' ? (
            <>
              daemon 已带着新版本回来并通过 doctor 验收
              {outcome.toCommit !== null && (
                <>
                  ,当前运行{' '}
                  <code className="font-mono">{outcome.toCommit}</code>
                </>
              )}
              。
            </>
          ) : outcome.state === 'rolled-back' ? (
            '构建失败,代码已回退到升级前的版本并重新构建,daemon 未重启、照常服务。修复原因后可再试。'
          ) : (
            '查看下方日志与服务器上的 journalctl -u dormice-upgrade;修复原因后在服务器上重跑 install.sh 即可修复安装。'
          )}
        </DialogDescription>
      </DialogHeader>

      {outcome === null && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner />
          {unreachable ? '等待 daemon 重启完成' : '实时输出'}
        </div>
      )}
      {outcome !== null && outcome.error !== null && (
        <p className="text-sm text-destructive">{outcome.error}</p>
      )}
      {log !== null && (
        <pre
          ref={logRef}
          className="max-h-64 overflow-y-auto rounded-md border bg-muted/30 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap"
        >
          {log}
        </pre>
      )}

      <DialogFooter>
        <Button
          variant={outcome?.state === 'succeeded' ? 'default' : 'outline'}
          onClick={onClose}
        >
          {outcome === null ? '转到后台(升级继续)' : '关闭'}
        </Button>
      </DialogFooter>
    </>
  );
}
