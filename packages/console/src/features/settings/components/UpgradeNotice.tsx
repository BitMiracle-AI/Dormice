import { useNavigate } from '@tanstack/react-router';
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
import { useCheckUpgrade } from '../hooks/useUpgrade';

/**
 * 开台升级提醒:挂在 AppShell 上,登录后查一次版本(与版本页共用
 * ['checkUpgrade'] 缓存,侧栏角标因此从开台起就能亮)。只在 upgradable
 * 且该版本未被忽略时弹,一次会话至多弹一次(prompted ref)——升级期间
 * 缓存失效翻动数据是轮询回声,不许把人关掉的弹窗再弹回来。
 *
 * 弹窗只做告知,不做升级:「去升级」跳版本页,真进度的 UpgradeDialog
 * 在那里,不复制第二套升级装置。checkError / 本地分叉(aheadBy>0)这些
 * 复杂情况刻意不弹 — 留给版本页讲清楚。
 *
 * 「忽略此版本」按 latest commit 记 localStorage(trunk 无发版 tag,
 * "一个版本"诚实地就是一个提交):main 上出现更新的提交即重新提醒;
 * 右上角关闭 = 只关这次,下次开台再提醒。忽略只静音弹窗,不熄灭侧栏
 * 角标 — 被动信号不打扰人,也不撒谎。
 */
const DISMISSED_KEY = 'dormice.console.dismissed-upgrade';

export function UpgradeNotice() {
  const { data } = useCheckUpgrade();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const prompted = useRef(false);

  const check = data?.check ?? null;
  const current = data?.current ?? null;
  const latestCommit = check?.upgradable ? check.latest.commit : null;
  useEffect(() => {
    if (prompted.current || latestCommit === null) return;
    if (localStorage.getItem(DISMISSED_KEY) === latestCommit) return;
    prompted.current = true;
    setOpen(true);
  }, [latestCommit]);

  if (check === null || !check.upgradable) return null;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>有新版本可用</DialogTitle>
          <DialogDescription>
            {current !== null && (
              <>
                当前 <code className="font-mono">{current.commit}</code>,
              </>
            )}
            落后 {check.behindBy} 个提交,最新{' '}
            <code className="font-mono">{check.latest.commit}</code>
          </DialogDescription>
        </DialogHeader>
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
              还有 {check.behindBy - check.commits.length} 个更早的提交未列出
            </li>
          )}
        </ul>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              localStorage.setItem(DISMISSED_KEY, check.latest.commit);
              setOpen(false);
            }}
          >
            忽略此版本
          </Button>
          <Button
            onClick={() => {
              setOpen(false);
              navigate({ to: '/version' });
            }}
          >
            去升级
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
