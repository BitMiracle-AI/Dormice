import type { Sandbox } from '@dormice/shared';
import { Settings02Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { useConfig } from '@/features/settings/hooks/useConfig';
import { updatePolicy } from '@/lib/api';
import { queryClient } from '@/lib/queryClient';
import { m } from '@/paraglide/messages';
import { durationHint } from '../format';

/** 三旋钮逐项比:批量编辑要判断"全体现值是否一致"。 */
function samePolicy(a: Sandbox['policy'], b: Sandbox['policy']): boolean {
  return (
    a.freezeAfterSeconds === b.freezeAfterSeconds &&
    a.stopAfterSeconds === b.stopAfterSeconds &&
    a.archiveAfterSeconds === b.archiveAfterSeconds
  );
}

/**
 * acquire 只在创建时收策略,这个弹窗是之后的正门:updatePolicy 纯改账本,
 * 不唤醒、不重置空闲时钟 — 把跑了几天的沙箱升格成常驻 agent 不再需要
 * 销毁重建(那会销毁磁盘)。三个旋钮整体提交:界面上看到什么就写下什么,
 * 关掉"永不停止"时归档旋钮的取舍也一并说清,不留隐式合并的悬念。
 *
 * 收一批沙箱,一个就是详情页的单改,多个就是列表页的批量改 — 表单、
 * 校验、提交只活在这一处,不为批量另造第二份策略表单(也不设策略页:
 * 策略不是实体,批量的前置动作"圈定哪些沙箱"正是列表页的筛选+勾选)。
 * updatePolicy 逐个调用(daemon 的 per-key 锁本来就逐个裁决),失败的
 * 留在弹窗里点名,弹窗不关 — 改对了几个账本已经记下,再点一次保存是
 * 幂等的补写,不是重复动作。
 */
export function EditPolicyDialog({ sandboxes }: { sandboxes: Sandbox[] }) {
  const [open, setOpen] = useState(false);
  const [freezeAfter, setFreezeAfter] = useState('');
  const [neverStop, setNeverStop] = useState(false);
  const [stopAfter, setStopAfter] = useState('');
  const [neverArchive, setNeverArchive] = useState(false);
  const [archiveAfter, setArchiveAfter] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const archive = useConfig().data?.archive;

  const first = sandboxes[0];
  const single = sandboxes.length === 1 ? (first ?? null) : null;
  // 批量时的"现值"只在全体一致时存在:策略各异还预填某一个,等于
  // 谎报其余沙箱的现状,不如从空表单起步,填什么就统一成什么。
  const shared =
    first && sandboxes.every((s) => samePolicy(s.policy, first.policy))
      ? first.policy
      : null;

  // 每次打开都从现值起步(有现值时) — 编辑的是"现在是什么",不是空表单。
  const loadCurrent = () => {
    setFreezeAfter(shared ? String(shared.freezeAfterSeconds) : '');
    setNeverStop(shared !== null && shared.stopAfterSeconds === null);
    setStopAfter(
      shared?.stopAfterSeconds ? String(shared.stopAfterSeconds) : '',
    );
    setNeverArchive(shared !== null && shared.archiveAfterSeconds === null);
    setArchiveAfter(
      shared?.archiveAfterSeconds ? String(shared.archiveAfterSeconds) : '',
    );
    setError(null);
  };

  const submit = async () => {
    const policy = {
      freezeAfterSeconds: Number(freezeAfter),
      stopAfterSeconds: neverStop ? null : Number(stopAfter),
      // 永不停止连带永不归档(没停过就没得归档);归档未启用时保持
      // 现值不动 — 一个 daemon 没资格许诺的旋钮,这里也不碰。
      ...(archive?.enabled
        ? {
            archiveAfterSeconds:
              neverStop || neverArchive ? null : Number(archiveAfter),
          }
        : {}),
    };
    setPending(true);
    const failures: Array<{ name: string; message: string }> = [];
    for (const sandbox of sandboxes) {
      try {
        await updatePolicy(sandbox.name, policy);
      } catch (cause) {
        failures.push({
          name: sandbox.name,
          message: cause instanceof Error ? cause.message : String(cause),
        });
      }
    }
    setPending(false);
    // 成败都刷新:部分成功也已经改了账本,列表要如实跟上。
    void queryClient.invalidateQueries({ queryKey: ['sandboxes'] });
    const firstFailure = failures[0];
    if (!firstFailure) {
      toast.success(
        single
          ? m.sandboxes_policy_updated({ name: single.name })
          : m.sandboxes_policy_updated_bulk({ n: sandboxes.length }),
      );
      setOpen(false);
    } else if (single) {
      setError(firstFailure.message);
    } else {
      // 批量失败几乎总是同一个原因,点名全部+报第一条错误就够诊断。
      setError(
        m.sandboxes_policy_update_failed({
          n: failures.length,
          names: failures.map((f) => f.name).join(m.sandboxes_name_separator()),
          message: firstFailure.message,
        }),
      );
    }
  };

  const filled = (raw: string) => raw.trim() !== '' && Number(raw) > 0;
  const valid =
    filled(freezeAfter) &&
    (neverStop || filled(stopAfter)) &&
    (!archive?.enabled || neverStop || neverArchive || filled(archiveAfter));

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) loadCurrent();
      }}
    >
      <DialogTrigger
        render={
          <Button variant="outline" size="sm">
            <HugeiconsIcon icon={Settings02Icon} />
            {m.sandboxes_edit_policy()}
            {!single && m.sandboxes_edit_policy_count({ n: sandboxes.length })}
          </Button>
        }
      />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {single
              ? m.sandboxes_edit_policy_title({ name: single.name })
              : m.sandboxes_edit_policy_title_bulk({ n: sandboxes.length })}
          </DialogTitle>
          <DialogDescription>
            {m.sandboxes_edit_policy_desc()}
            {!single && shared === null && m.sandboxes_policy_mixed_note()}
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="policy-freeze-after">
                {m.sandboxes_freeze_after_label()}
              </FieldLabel>
              <Input
                id="policy-freeze-after"
                type="number"
                min={1}
                value={freezeAfter}
                onChange={(event) => setFreezeAfter(event.target.value)}
              />
              <FieldDescription>
                {m.sandboxes_freeze_desc()}
                {durationHint(freezeAfter) && ` ${durationHint(freezeAfter)}`}
              </FieldDescription>
            </Field>
            <Field orientation="horizontal">
              <Switch
                id="policy-never-stop"
                checked={neverStop}
                onCheckedChange={setNeverStop}
              />
              <FieldLabel htmlFor="policy-never-stop">
                {m.sandboxes_never_stop_label()}
              </FieldLabel>
            </Field>
            {!neverStop && (
              <Field>
                <FieldLabel htmlFor="policy-stop-after">
                  {m.sandboxes_stop_after_label()}
                </FieldLabel>
                <Input
                  id="policy-stop-after"
                  type="number"
                  min={1}
                  value={stopAfter}
                  onChange={(event) => setStopAfter(event.target.value)}
                />
                <FieldDescription>
                  {m.sandboxes_stop_desc()}
                  {durationHint(stopAfter) && ` ${durationHint(stopAfter)}`}
                </FieldDescription>
              </Field>
            )}
            {archive?.enabled && !neverStop && (
              <>
                <Field orientation="horizontal">
                  <Switch
                    id="policy-never-archive"
                    checked={neverArchive}
                    onCheckedChange={setNeverArchive}
                  />
                  <FieldLabel htmlFor="policy-never-archive">
                    {m.sandboxes_never_archive_label()}
                  </FieldLabel>
                </Field>
                {!neverArchive && (
                  <Field>
                    <FieldLabel htmlFor="policy-archive-after">
                      {m.sandboxes_archive_after_label()}
                    </FieldLabel>
                    <Input
                      id="policy-archive-after"
                      type="number"
                      min={1}
                      value={archiveAfter}
                      onChange={(event) => setArchiveAfter(event.target.value)}
                    />
                    <FieldDescription>
                      {m.sandboxes_archive_desc()}
                      {durationHint(archiveAfter) &&
                        ` ${durationHint(archiveAfter)}`}
                    </FieldDescription>
                  </Field>
                )}
              </>
            )}
            {error && <FieldError>{error}</FieldError>}
          </FieldGroup>
          <DialogFooter className="mt-6">
            <Button type="submit" disabled={!valid || pending}>
              {pending && <Spinner />}
              {m.common_save()}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
