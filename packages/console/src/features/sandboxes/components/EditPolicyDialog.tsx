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
import { durationHint } from '../format';
import { useUpdatePolicy } from '../hooks/useSandboxes';

/**
 * acquire 只在创建时收策略,这个弹窗是之后的正门:updatePolicy 纯改账本,
 * 不唤醒、不重置空闲时钟 — 把跑了几天的沙箱升格成常驻 agent 不再需要
 * 销毁重建(那会销毁磁盘)。三个旋钮整体提交:界面上看到什么就写下什么,
 * 关掉"永不停止"时归档旋钮的取舍也一并说清,不留隐式合并的悬念。
 */
export function EditPolicyDialog({ sandbox }: { sandbox: Sandbox }) {
  const [open, setOpen] = useState(false);
  const [freezeAfter, setFreezeAfter] = useState('');
  const [neverStop, setNeverStop] = useState(false);
  const [stopAfter, setStopAfter] = useState('');
  const [neverArchive, setNeverArchive] = useState(false);
  const [archiveAfter, setArchiveAfter] = useState('');
  const mutation = useUpdatePolicy();
  const archive = useConfig().data?.archive;

  // 每次打开都从沙箱的现值起步 — 编辑的是"现在是什么",不是空表单。
  const loadCurrent = () => {
    const { policy } = sandbox;
    setFreezeAfter(String(policy.freezeAfterSeconds));
    setNeverStop(policy.stopAfterSeconds === null);
    setStopAfter(
      policy.stopAfterSeconds === null ? '' : String(policy.stopAfterSeconds),
    );
    setNeverArchive(policy.archiveAfterSeconds === null);
    setArchiveAfter(
      policy.archiveAfterSeconds === null
        ? ''
        : String(policy.archiveAfterSeconds),
    );
    mutation.reset();
  };

  const submit = () => {
    mutation.mutate(
      {
        externalId: sandbox.externalId,
        policy: {
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
        },
      },
      {
        onSuccess: () => {
          toast.success(`「${sandbox.externalId}」的策略已更新`);
          setOpen(false);
        },
      },
    );
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
            调整策略
          </Button>
        }
      />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>调整「{sandbox.externalId}」的生命周期策略</DialogTitle>
          <DialogDescription>
            立即生效,只改账本 — 沉睡的沙箱不会被吵醒,空闲计时也不重置
            (新阈值按已累积的空闲时间判定)。
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="policy-freeze-after">
                空闲多久后冻结(秒)
              </FieldLabel>
              <Input
                id="policy-freeze-after"
                type="number"
                min={1}
                value={freezeAfter}
                onChange={(event) => setFreezeAfter(event.target.value)}
              />
              <FieldDescription>
                运行中 → 已冻结:内存挤入 swap,唤醒约 50ms。
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
                永不停止(常驻 agent)
              </FieldLabel>
            </Field>
            {!neverStop && (
              <Field>
                <FieldLabel htmlFor="policy-stop-after">
                  空闲多久后停止(秒)
                </FieldLabel>
                <Input
                  id="policy-stop-after"
                  type="number"
                  min={1}
                  value={stopAfter}
                  onChange={(event) => setStopAfter(event.target.value)}
                />
                <FieldDescription>
                  已冻结 → 已停止:只留磁盘,唤醒是冷启动。
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
                    永不归档
                  </FieldLabel>
                </Field>
                {!neverArchive && (
                  <Field>
                    <FieldLabel htmlFor="policy-archive-after">
                      空闲多久后归档(秒)
                    </FieldLabel>
                    <Input
                      id="policy-archive-after"
                      type="number"
                      min={1}
                      value={archiveAfter}
                      onChange={(event) => setArchiveAfter(event.target.value)}
                    />
                    <FieldDescription>
                      已停止 → 已归档:磁盘压缩上传 S3,本地零占用。
                      {durationHint(archiveAfter) &&
                        ` ${durationHint(archiveAfter)}`}
                    </FieldDescription>
                  </Field>
                )}
              </>
            )}
            {mutation.isError && (
              <FieldError>{mutation.error.message}</FieldError>
            )}
          </FieldGroup>
          <DialogFooter className="mt-6">
            <Button type="submit" disabled={!valid || mutation.isPending}>
              {mutation.isPending && <Spinner />}
              保存
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
