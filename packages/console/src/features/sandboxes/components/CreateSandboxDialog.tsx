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
import { m } from '@/paraglide/messages';
import { durationHint, stateLabel } from '../format';
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
              ? m.sandboxes_created_toast({ name: sandbox.name })
              : m.sandboxes_reacquired_toast({ name: sandbox.name }),
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
            {m.sandboxes_create()}
          </Button>
        }
      />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{m.sandboxes_create()}</DialogTitle>
          <DialogDescription>{m.sandboxes_create_desc()}</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="create-sandbox-name">
                {m.sandboxes_field_name()}
              </FieldLabel>
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
                  ? m.sandboxes_name_exists_desc({
                      state: stateLabel(existing.state),
                    })
                  : m.sandboxes_name_desc()}
              </FieldDescription>
            </Field>
            {templates.length > 0 && (
              <Field>
                <FieldLabel htmlFor="create-template">
                  {m.sandboxes_field_template()}
                </FieldLabel>
                <NativeSelect
                  id="create-template"
                  className="w-full"
                  value={template}
                  onChange={(event) => setTemplate(event.target.value)}
                >
                  <NativeSelectOption value="">
                    {m.sandboxes_base_image()}
                  </NativeSelectOption>
                  {templates.map((t) => (
                    <NativeSelectOption key={t.name} value={t.name}>
                      {t.name} ({t.image})
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
                <FieldDescription>
                  {m.sandboxes_template_desc()}
                </FieldDescription>
              </Field>
            )}
            <Field>
              <FieldLabel htmlFor="create-freeze-after">
                {m.sandboxes_freeze_after_label()}
              </FieldLabel>
              <Input
                id="create-freeze-after"
                type="number"
                min={1}
                value={freezeAfter}
                onChange={(event) => setFreezeAfter(event.target.value)}
                placeholder={m.sandboxes_freeze_after_placeholder()}
              />
              <FieldDescription>
                {m.sandboxes_freeze_desc_create()}
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
                {m.sandboxes_never_stop_label()}
              </FieldLabel>
            </Field>
            {!neverStop && (
              <Field>
                <FieldLabel htmlFor="create-stop-after">
                  {m.sandboxes_stop_after_label()}
                </FieldLabel>
                <Input
                  id="create-stop-after"
                  type="number"
                  min={1}
                  value={stopAfter}
                  onChange={(event) => setStopAfter(event.target.value)}
                  placeholder={m.sandboxes_stop_after_placeholder()}
                />
                <FieldDescription>
                  {m.sandboxes_stop_desc_create()}
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
                    {m.sandboxes_never_archive_label()}
                  </FieldLabel>
                </Field>
                {!neverArchive && (
                  <Field>
                    <FieldLabel htmlFor="create-archive-after">
                      {m.sandboxes_archive_after_label()}
                    </FieldLabel>
                    <Input
                      id="create-archive-after"
                      type="number"
                      min={1}
                      value={archiveAfter}
                      onChange={(event) => setArchiveAfter(event.target.value)}
                      placeholder={m.sandboxes_archive_after_placeholder({
                        n: archive.defaultSeconds ?? '',
                      })}
                    />
                    <FieldDescription>
                      {m.sandboxes_archive_desc_create()}
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
              {existing
                ? m.sandboxes_reacquire_submit()
                : m.sandboxes_create_submit()}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
