import type { AcquireRequest } from '@dormice/shared';
import { Add01Icon } from '@hugeicons/core-free-icons';
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
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { useConfig } from '@/features/settings/hooks/useConfig';
import { useTemplates } from '@/features/templates/hooks/useTemplates';
import { durationHint, STATE_LABELS } from '../format';
import { useAcquireSandbox, useSandboxes } from '../hooks/useSandboxes';

/**
 * The console speaks the same verb as everyone else: acquire. Same key,
 * same sandbox — "creating" an existing key just returns it (the policy
 * override only applies when the acquire actually creates).
 *
 * The policy knobs are optional; empty means the daemon's default. The
 * archive knob only exists when the daemon says archiving is available
 * (getConfig's adjudication) — an unconfigured feature stays honestly
 * absent. A never-stop sandbox never reaches stopped, so its archive knob
 * disappears too.
 */
export function CreateSandboxDialog() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [template, setTemplate] = useState('');
  const [freezeAfter, setFreezeAfter] = useState('');
  const [neverStop, setNeverStop] = useState(false);
  const [stopAfter, setStopAfter] = useState('');
  const [neverArchive, setNeverArchive] = useState(false);
  const [archiveAfter, setArchiveAfter] = useState('');
  const mutation = useAcquireSandbox();
  const templates = useTemplates().data?.templates ?? [];
  const archive = useConfig().data?.archive;
  // 名字撞车不报错而是拿回旧沙箱 — 没有 duplicate 报错来教这件事,
  // 所以在扣扳机前一秒把真相亮出来:列表缓存本来就 2 秒一刷,免费。
  const existing = useSandboxes().data?.sandboxes.find((s) => s.name === name);

  const reset = () => {
    setName('');
    setTemplate('');
    setFreezeAfter('');
    setNeverStop(false);
    setStopAfter('');
    setNeverArchive(false);
    setArchiveAfter('');
    mutation.reset();
  };

  const submit = () => {
    const policy: NonNullable<AcquireRequest['policy']> = {};
    if (freezeAfter !== '') policy.freezeAfterSeconds = Number(freezeAfter);
    if (neverStop) policy.stopAfterSeconds = null;
    else if (stopAfter !== '') policy.stopAfterSeconds = Number(stopAfter);
    if (archive?.enabled && !neverStop) {
      if (neverArchive) policy.archiveAfterSeconds = null;
      else if (archiveAfter !== '')
        policy.archiveAfterSeconds = Number(archiveAfter);
    }

    mutation.mutate(
      {
        name,
        ...(template !== '' ? { template } : {}),
        ...(Object.keys(policy).length > 0 ? { policy } : {}),
      },
      {
        onSuccess: ({ created, sandbox }) => {
          // created 让幂等可见:拿回旧沙箱时不许谎报"已创建"。
          toast.success(
            created
              ? `「${sandbox.name}」的沙箱已创建`
              : `拿回了已有的沙箱「${sandbox.name}」`,
          );
          setOpen(false);
          reset();
        },
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger
        render={
          <Button>
            <HugeiconsIcon icon={Add01Icon} />
            创建沙箱
          </Button>
        }
      />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>创建沙箱</DialogTitle>
          <DialogDescription>
            acquire 是幂等的:名字已经有沙箱时,拿回的是原来那个,
            下面的模板和策略不会应用。
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
              <FieldLabel htmlFor="create-sandbox-name">名称</FieldLabel>
              <Input
                id="create-sandbox-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="my-agent"
                maxLength={128}
                className="font-mono"
              />
              <FieldDescription>
                {existing
                  ? `这个名字已有沙箱(${STATE_LABELS[existing.state]})— 提交会直接拿回它,下面的模板和策略不会应用。`
                  : '你起的唯一名字,acquire 对它幂等 — 同一个名字永远回到同一个沙箱。'}
              </FieldDescription>
            </Field>
            {templates.length > 0 && (
              <Field>
                <FieldLabel htmlFor="create-template">模板</FieldLabel>
                <NativeSelect
                  id="create-template"
                  className="w-full"
                  value={template}
                  onChange={(event) => setTemplate(event.target.value)}
                >
                  <NativeSelectOption value="">基础镜像</NativeSelectOption>
                  {templates.map((t) => (
                    <NativeSelectOption key={t.name} value={t.name}>
                      {t.name} ({t.image})
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
                <FieldDescription>
                  只在这个 key 真正新建沙箱时生效;对已有沙箱静默不应用。
                </FieldDescription>
              </Field>
            )}
            <Field>
              <FieldLabel htmlFor="create-freeze-after">
                空闲多久后冻结(秒)
              </FieldLabel>
              <Input
                id="create-freeze-after"
                type="number"
                min={1}
                value={freezeAfter}
                onChange={(event) => setFreezeAfter(event.target.value)}
                placeholder="600(daemon 默认)"
              />
              <FieldDescription>
                运行中 → 已冻结的空闲阈值:内存挤入 swap,唤醒约 50ms。
                {durationHint(freezeAfter) && ` ${durationHint(freezeAfter)}`}
              </FieldDescription>
            </Field>
            <Field orientation="horizontal">
              <Switch
                id="create-never-stop"
                checked={neverStop}
                onCheckedChange={setNeverStop}
              />
              <FieldLabel htmlFor="create-never-stop">
                永不停止(常驻 agent)
              </FieldLabel>
            </Field>
            {!neverStop && (
              <Field>
                <FieldLabel htmlFor="create-stop-after">
                  空闲多久后停止(秒)
                </FieldLabel>
                <Input
                  id="create-stop-after"
                  type="number"
                  min={1}
                  value={stopAfter}
                  onChange={(event) => setStopAfter(event.target.value)}
                  placeholder="259200(daemon 默认)"
                />
                <FieldDescription>
                  已冻结 → 已停止的空闲阈值:只留磁盘,唤醒是冷启动。
                  {durationHint(stopAfter) && ` ${durationHint(stopAfter)}`}
                </FieldDescription>
              </Field>
            )}
            {archive?.enabled && !neverStop && (
              <>
                <Field orientation="horizontal">
                  <Switch
                    id="create-never-archive"
                    checked={neverArchive}
                    onCheckedChange={setNeverArchive}
                  />
                  <FieldLabel htmlFor="create-never-archive">
                    永不归档
                  </FieldLabel>
                </Field>
                {!neverArchive && (
                  <Field>
                    <FieldLabel htmlFor="create-archive-after">
                      空闲多久后归档(秒)
                    </FieldLabel>
                    <Input
                      id="create-archive-after"
                      type="number"
                      min={1}
                      value={archiveAfter}
                      onChange={(event) => setArchiveAfter(event.target.value)}
                      placeholder={`${archive.defaultSeconds ?? ''}(daemon 默认)`}
                    />
                    <FieldDescription>
                      已停止 → 已归档:磁盘压缩上传 S3,本地零占用;
                      唤醒要下载解压,慢但有真进度。
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
            <Button
              type="submit"
              disabled={name.length === 0 || mutation.isPending}
            >
              {mutation.isPending && <Spinner />}
              {existing ? '拿回已有沙箱' : '创建'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
