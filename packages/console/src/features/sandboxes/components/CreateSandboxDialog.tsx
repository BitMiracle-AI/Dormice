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
import { useAcquireSandbox } from '../hooks/useSandboxes';
import { useTemplates } from '../hooks/useTemplates';

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
          toast.success(`Sandbox ready for “${sandbox.userKey}”`);
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
            Create sandbox
          </Button>
        }
      />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create a sandbox</DialogTitle>
          <DialogDescription>
            Acquire is idempotent: if this key already has a sandbox, you get
            that one back and the policy below is ignored.
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
              <FieldLabel htmlFor="create-user-key">User key</FieldLabel>
              <Input
                id="create-user-key"
                value={userKey}
                onChange={(event) => setUserKey(event.target.value)}
                placeholder="my-agent"
                maxLength={128}
                className="font-mono"
              />
              <FieldDescription>
                The caller-chosen identity acquire is idempotent on — the same
                key always comes back to the same sandbox.
              </FieldDescription>
            </Field>
            {templates.length > 0 && (
              <Field>
                <FieldLabel htmlFor="create-template">Template</FieldLabel>
                <NativeSelect
                  id="create-template"
                  className="w-full"
                  value={template}
                  onChange={(event) => setTemplate(event.target.value)}
                >
                  <NativeSelectOption value="">Base image</NativeSelectOption>
                  {templates.map((t) => (
                    <NativeSelectOption key={t.name} value={t.name}>
                      {t.name} ({t.image})
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
                <FieldDescription>
                  Applied only when this key creates a new sandbox. Register
                  templates with `dor template add`.
                </FieldDescription>
              </Field>
            )}
            <Field>
              <FieldLabel htmlFor="create-freeze-after">
                Freeze after idle (seconds)
              </FieldLabel>
              <Input
                id="create-freeze-after"
                type="number"
                min={1}
                value={freezeAfter}
                onChange={(event) => setFreezeAfter(event.target.value)}
                placeholder="600 (daemon default)"
              />
              <FieldDescription>
                Idle time until active → frozen: memory squeezed to swap, ~50ms
                to wake.
              </FieldDescription>
            </Field>
            <Field orientation="horizontal">
              <Switch
                id="create-never-stop"
                checked={neverStop}
                onCheckedChange={setNeverStop}
              />
              <FieldLabel htmlFor="create-never-stop">
                Never stop (resident agent)
              </FieldLabel>
            </Field>
            {!neverStop && (
              <Field>
                <FieldLabel htmlFor="create-stop-after">
                  Stop after idle (seconds)
                </FieldLabel>
                <Input
                  id="create-stop-after"
                  type="number"
                  min={1}
                  value={stopAfter}
                  onChange={(event) => setStopAfter(event.target.value)}
                  placeholder="259200 (daemon default)"
                />
                <FieldDescription>
                  Idle time until frozen → stopped: only the disk stays, waking
                  is a cold start.
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
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
