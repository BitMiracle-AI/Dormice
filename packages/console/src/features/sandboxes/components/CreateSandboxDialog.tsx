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
import { useTemplates } from '@/features/templates/hooks/useTemplates';
import { useAcquireSandbox } from '../hooks/useSandboxes';

/**
 * The console speaks the same verb as everyone else: acquire. Same key,
 * same sandbox — "creating" an existing key just returns it (the policy
 * override only applies when the acquire actually creates).
 *
 * The two policy knobs are optional; empty means the daemon's default.
 * Archive has no knob here on purpose: there is no archiver yet, so the
 * only honest value is the default (never).
 */
export function CreateSandboxDialog() {
  const [open, setOpen] = useState(false);
  const [userKey, setUserKey] = useState('');
  const [template, setTemplate] = useState('');
  const [freezeAfter, setFreezeAfter] = useState('');
  const [neverStop, setNeverStop] = useState(false);
  const [stopAfter, setStopAfter] = useState('');
  const mutation = useAcquireSandbox();
  const templates = useTemplates().data?.templates ?? [];

  const reset = () => {
    setUserKey('');
    setTemplate('');
    setFreezeAfter('');
    setNeverStop(false);
    setStopAfter('');
    mutation.reset();
  };

  const submit = () => {
    const policy: NonNullable<AcquireRequest['policy']> = {};
    if (freezeAfter !== '') policy.freezeAfterSeconds = Number(freezeAfter);
    if (neverStop) policy.stopAfterSeconds = null;
    else if (stopAfter !== '') policy.stopAfterSeconds = Number(stopAfter);

    mutation.mutate(
      {
        userKey,
        ...(template !== '' ? { template } : {}),
        ...(Object.keys(policy).length > 0 ? { policy } : {}),
      },
      {
        onSuccess: ({ sandbox }) => {
          toast.success(`「${sandbox.userKey}」的沙箱已就绪`);
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
          <Button size="sm">
            <HugeiconsIcon icon={Add01Icon} />
            创建沙箱
          </Button>
        }
      />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>创建沙箱</DialogTitle>
          <DialogDescription>
            acquire 是幂等的:这个 key 已经有沙箱时,拿回的是原来那个,
            下面的策略会被忽略。
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
              <FieldLabel htmlFor="create-user-key">userKey</FieldLabel>
              <Input
                id="create-user-key"
                value={userKey}
                onChange={(event) => setUserKey(event.target.value)}
                placeholder="my-agent"
                maxLength={128}
                className="font-mono"
              />
              <FieldDescription>
                调用方自选的身份,acquire 对它幂等 — 同一个 key 永远回到
                同一个沙箱。
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
                </FieldDescription>
              </Field>
            )}
            {mutation.isError && (
              <FieldError>{mutation.error.message}</FieldError>
            )}
          </FieldGroup>
          <DialogFooter className="mt-6">
            <Button
              type="submit"
              disabled={userKey.length === 0 || mutation.isPending}
            >
              {mutation.isPending && <Spinner />}
              创建
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
