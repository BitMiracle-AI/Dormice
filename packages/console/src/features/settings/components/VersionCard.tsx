import type { CheckUpgradeResponse } from '@dormice/shared';
import { RefreshIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { formatDateTime } from '@/lib/datetime';
import { m } from '@/paraglide/messages';
import {
  useCheckUpgrade,
  useForceCheckUpgrade,
  useUpgradeStatus,
} from '../hooks/useUpgrade';
import { UpgradeDialog } from './UpgradeDialog';

/**
 * daemon 自己的版本与升级窗口。「版本」= 构建进 dist 的 git commit
 * (还没有发版 tag,main 上每个提交都过验收链);比较由 daemon 服务端
 * 裁决(upgradable 字段),这里只负责显示 — 与沙箱「可升级」徽章同一
 * 纪律。检查失败如实显示 checkError,绝不把失败装成「已是最新」。
 * 「升级」按钮只在 daemon 自报一键可用时出现,否则给手动路径与原因。
 */
export function VersionCard() {
  const { data, isPending, isError, error } = useCheckUpgrade();
  const force = useForceCheckUpgrade();
  const status = useUpgradeStatus();
  const [dialogOpen, setDialogOpen] = useState(false);
  const running = status.data?.running ?? false;
  const last = status.data?.last ?? null;

  // 升级跑完(running 翻回 false)重新裁决版本与配置。弹窗开着时它自己
  // 会做这次失效;这里兜住弹窗已关、升级在后台跑完的那条路。
  const queryClient = useQueryClient();
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !running) {
      queryClient.invalidateQueries({ queryKey: ['checkUpgrade'] });
      queryClient.invalidateQueries({ queryKey: ['config'] });
    }
    wasRunning.current = running;
  }, [running, queryClient]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.settings_version_title()}</CardTitle>
        <CardDescription>{m.settings_version_card_desc()}</CardDescription>
        <CardAction>
          <Button
            variant="outline"
            size="sm"
            disabled={isPending || force.isPending}
            onClick={() => force.mutate()}
          >
            {force.isPending ? (
              <Spinner />
            ) : (
              <HugeiconsIcon icon={RefreshIcon} />
            )}
            {m.settings_check_updates()}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {running && (
          <div className="flex items-center justify-between gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
            <span className="flex items-center gap-2">
              <Spinner /> {m.settings_upgrade_running_banner()}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setDialogOpen(true)}
            >
              {m.settings_view_progress()}
            </Button>
          </div>
        )}
        {/* 后台跑完的失败/回退不能无声消失:上一份报告就在这里说话。 */}
        {!running &&
          last !== null &&
          (last.state === 'failed' || last.state === 'rolled-back') && (
            <p className="text-sm text-destructive">
              {last.state === 'rolled-back'
                ? m.settings_last_upgrade_rolled_back()
                : m.settings_last_upgrade_failed()}
              {last.finishedAt !== null &&
                m.settings_time_paren({
                  time: formatDateTime(last.finishedAt),
                })}
              {last.error !== null &&
                m.settings_error_suffix({ error: last.error })}
            </p>
          )}
        {force.isError && (
          <p className="text-sm text-destructive">
            {m.settings_check_failed({ error: force.error.message })}
          </p>
        )}
        {isPending ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> {m.settings_checking_version()}
          </div>
        ) : isError ? (
          <p className="text-sm text-destructive">
            {m.settings_check_failed({ error: error.message })}
          </p>
        ) : (
          <VersionBody
            data={data}
            oneClick={
              status.data === undefined
                ? // 执行窗还没答复:既不许诺按钮,也不指控「不可用」。
                  null
                : status.data.available
                  ? { onUpgrade: () => setDialogOpen(true), running }
                  : { reason: status.data.unavailableReason }
            }
          />
        )}
      </CardContent>
      <UpgradeDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        alreadyRunning={running}
        baselineStartedAt={last?.startedAt ?? null}
      />
    </Card>
  );
}

/** 一键可用 → 按钮;不可用 → 手动指引 + daemon 自报的原因;null = 还不知道。 */
type OneClick =
  | { onUpgrade: () => void; running: boolean }
  | { reason: string | null }
  | null;

function VersionBody({
  data,
  oneClick,
}: {
  data: CheckUpgradeResponse;
  oneClick: OneClick;
}) {
  const { current, check, checkError } = data;
  return (
    <>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
        <span className="text-muted-foreground">
          {m.settings_current_version()}
        </span>
        {current ? (
          <>
            <code className="font-mono font-medium">{current.commit}</code>
            <span
              className="min-w-0 truncate text-muted-foreground"
              title={formatDateTime(current.committedAt)}
            >
              {current.title}
            </span>
          </>
        ) : (
          <span className="text-muted-foreground">
            {m.settings_version_unknown()}
          </span>
        )}
      </div>

      {checkError !== null && (
        <p className="text-sm text-destructive">
          {m.settings_check_update_failed({ error: checkError })}
        </p>
      )}

      {check &&
        (check.upgradable ? (
          <UpgradePreview check={check} oneClick={oneClick} />
        ) : check.aheadBy > 0 ? (
          <p className="text-sm text-amber-600 dark:text-amber-400">
            {m.settings_ahead_warning({ n: check.aheadBy })}
          </p>
        ) : (
          <p
            className="text-sm text-muted-foreground"
            title={formatDateTime(check.checkedAt)}
          >
            {m.settings_up_to_date()}
            {check.cached ? m.settings_up_to_date_cached() : ''}
          </p>
        ))}
    </>
  );
}

function UpgradePreview({
  check,
  oneClick,
}: {
  check: NonNullable<CheckUpgradeResponse['check']>;
  oneClick: OneClick;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2 text-sm">
        <div className="flex items-center gap-2">
          <Badge
            variant="outline"
            className="border-amber-500/40 bg-amber-500/10 font-medium text-amber-600 dark:text-amber-400"
          >
            {m.settings_upgradable_badge()}
          </Badge>
          <span>
            {m.settings_upgrade_behind({ n: check.behindBy })}{' '}
            <code className="font-mono">{check.latest.commit}</code>
          </span>
        </div>
        {oneClick !== null && 'onUpgrade' in oneClick && (
          <Button
            size="sm"
            disabled={oneClick.running}
            onClick={oneClick.onUpgrade}
          >
            {m.settings_upgrade_to_latest()}
          </Button>
        )}
      </div>
      <ul className="max-h-48 overflow-y-auto rounded-md border bg-muted/30 p-3 font-mono text-xs leading-relaxed">
        {check.commits.map((entry) => (
          <li key={entry.commit} className="flex gap-2">
            <span className="shrink-0 text-muted-foreground">
              {entry.commit}
            </span>
            <span className="min-w-0 truncate" title={entry.title}>
              {entry.title}
            </span>
          </li>
        ))}
        {check.behindBy > check.commits.length && (
          <li className="text-muted-foreground">
            {m.settings_upgrade_more_commits({
              n: check.behindBy - check.commits.length,
            })}
          </li>
        )}
      </ul>
      {oneClick !== null && 'reason' in oneClick && (
        <p className="text-sm text-muted-foreground">
          {m.settings_oneclick_unavailable()}
          {oneClick.reason !== null && (
            <>
              {m.settings_paren_open()}
              <span className="font-mono text-xs">{oneClick.reason}</span>
              {m.settings_paren_close()}
            </>
          )}
          {m.settings_oneclick_manual()}
        </p>
      )}
    </div>
  );
}
