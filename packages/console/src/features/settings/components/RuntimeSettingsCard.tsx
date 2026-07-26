import type {
  GetConfigResponse,
  RuntimeSettings,
  UpdateSettingsRequest,
} from '@dormice/shared';
import { PencilEdit02Icon } from '@hugeicons/core-free-icons';
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
import { durationHint, policyLine } from '@/features/sandboxes/format';
import { updateSettings } from '@/lib/api';
import { queryClient } from '@/lib/queryClient';
import { m } from '@/paraglide/messages';

/**
 * 运营旋钮的编辑区:值住在账本里(env 同名变量只是首次启动的种子),
 * updateSettings 一改立即生效 — 不重启 daemon、不碰任何沙箱。四组各配
 * 一个弹窗,给哪组就整组替换(updatePolicy 的规矩:界面上看到什么就写
 * 下什么)。改的是"之后"不是"已经":容量上限管下一次创建,默认配额管
 * 下一次出生的磁盘/容器,默认策略管下一次 acquire 创建的沙箱 — 存量
 * 沙箱一根汗毛都不动,这句话在每个弹窗里都说清。唯一的例外是 swap:
 * 它改的是宿主不是沙箱,增容立即、缩容等重启(swapLine 负责把这个
 * 时间差摆在明面上)。
 */

function useSubmit(onDone: () => void) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (patch: UpdateSettingsRequest, done: string) => {
    setPending(true);
    setError(null);
    try {
      await updateSettings(patch);
      toast.success(done);
      onDone();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      // 失败也刷新:swap 的 500 语义是"目标已存但应用失败",账本真的变了,
      // 行里必须立刻说真话。设置页读 config;总览的容量卡走 getHostMetrics
      // 自己的轮询。
      void queryClient.invalidateQueries({ queryKey: ['config'] });
      setPending(false);
    }
  };
  return { pending, error, setError, submit };
}

function EditRow({
  label,
  value,
  dialog,
}: {
  label: string;
  value: string;
  /** 缺席 = 本宿主改不了这项(value 里说清为什么),不给一个点了报错的按钮。 */
  dialog?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        <div className="truncate text-sm text-muted-foreground" title={value}>
          {value}
        </div>
      </div>
      {dialog}
    </div>
  );
}

function EditTrigger() {
  return (
    <DialogTrigger
      render={
        <Button variant="outline" size="sm">
          <HugeiconsIcon icon={PencilEdit02Icon} />
          {m.common_edit()}
        </Button>
      }
    />
  );
}

function MaxSandboxesDialog({ settings }: { settings: RuntimeSettings }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const { pending, error, setError, submit } = useSubmit(() => setOpen(false));

  const valid =
    value.trim() !== '' && Number.isInteger(Number(value)) && Number(value) > 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setValue(String(settings.maxSandboxes));
          setError(null);
        }
      }}
    >
      <EditTrigger />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{m.settings_max_dialog_title()}</DialogTitle>
          <DialogDescription>{m.settings_max_dialog_desc()}</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit(
              { maxSandboxes: Number(value) },
              m.settings_max_saved({ value: Number(value) }),
            );
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="settings-max-sandboxes">
                {m.settings_max_label()}
              </FieldLabel>
              <Input
                id="settings-max-sandboxes"
                type="number"
                min={1}
                value={value}
                onChange={(event) => setValue(event.target.value)}
              />
            </Field>
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

function SandboxDefaultsDialog({ settings }: { settings: RuntimeSettings }) {
  const [open, setOpen] = useState(false);
  const [cpus, setCpus] = useState('');
  const [memoryGb, setMemoryGb] = useState('');
  const [diskGb, setDiskGb] = useState('');
  const { pending, error, setError, submit } = useSubmit(() => setOpen(false));

  const filled = (raw: string) => raw.trim() !== '' && Number(raw) > 0;
  const valid = filled(cpus) && filled(memoryGb) && filled(diskGb);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setCpus(String(settings.sandboxDefaults.cpus));
          setMemoryGb(String(settings.sandboxDefaults.memoryGb));
          setDiskGb(String(settings.sandboxDefaults.diskGb));
          setError(null);
        }
      }}
    >
      <EditTrigger />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{m.settings_defaults_dialog_title()}</DialogTitle>
          <DialogDescription>
            {m.settings_defaults_dialog_desc()}
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit(
              {
                sandboxDefaults: {
                  cpus: Number(cpus),
                  memoryGb: Number(memoryGb),
                  diskGb: Number(diskGb),
                },
              },
              m.settings_defaults_saved(),
            );
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="settings-cpus">
                {m.settings_defaults_cpu_label()}
              </FieldLabel>
              <Input
                id="settings-cpus"
                type="number"
                min={0.1}
                step="any"
                value={cpus}
                onChange={(event) => setCpus(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="settings-memory">
                {m.settings_defaults_memory_label()}
              </FieldLabel>
              <Input
                id="settings-memory"
                type="number"
                min={0.1}
                step="any"
                value={memoryGb}
                onChange={(event) => setMemoryGb(event.target.value)}
              />
              <FieldDescription>
                {m.settings_defaults_memory_desc()}
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="settings-disk">
                {m.settings_defaults_disk_label()}
              </FieldLabel>
              <Input
                id="settings-disk"
                type="number"
                min={1}
                step="any"
                value={diskGb}
                onChange={(event) => setDiskGb(event.target.value)}
              />
              <FieldDescription>
                {m.settings_defaults_disk_desc()}
              </FieldDescription>
            </Field>
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

function SwapDialog({ settings }: { settings: RuntimeSettings }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const { pending, error, setError, submit } = useSubmit(() => setOpen(false));

  const valid =
    value.trim() !== '' &&
    Number.isInteger(Number(value)) &&
    Number(value) >= 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setValue(String(settings.swapGb));
          setError(null);
        }
      }}
    >
      <EditTrigger />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{m.settings_swap_dialog_title()}</DialogTitle>
          <DialogDescription>{m.settings_swap_dialog_desc()}</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit(
              { swapGb: Number(value) },
              m.settings_swap_saved({ value: Number(value) }),
            );
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="settings-swap-gb">
                {m.settings_swap_label()}
              </FieldLabel>
              <Input
                id="settings-swap-gb"
                type="number"
                min={0}
                value={value}
                onChange={(event) => setValue(event.target.value)}
              />
              <FieldDescription>
                {m.settings_swap_field_desc()}
              </FieldDescription>
            </Field>
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

/**
 * swap 行的真话:目标与现实一致时一句话完事;缩容等重启、增容没跑完时
 * 把两个数都摆出来 — 只报目标会在这两种时刻撒谎。
 */
function swapLine(targetGb: number, activeGb: number): string {
  if (activeGb > targetGb) {
    return m.settings_swap_line_shrink({ target: targetGb, active: activeGb });
  }
  if (activeGb < targetGb) {
    return m.settings_swap_line_grow({ target: targetGb, active: activeGb });
  }
  return m.settings_swap_line_ok({ target: targetGb });
}

function DefaultPolicyDialog({
  settings,
  archiveEnabled,
}: {
  settings: RuntimeSettings;
  archiveEnabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [freezeAfter, setFreezeAfter] = useState('');
  const [neverStop, setNeverStop] = useState(false);
  const [stopAfter, setStopAfter] = useState('');
  const [neverArchive, setNeverArchive] = useState(false);
  const [archiveAfter, setArchiveAfter] = useState('');
  const { pending, error, setError, submit } = useSubmit(() => setOpen(false));

  const filled = (raw: string) => raw.trim() !== '' && Number(raw) > 0;
  const valid =
    filled(freezeAfter) &&
    (neverStop || filled(stopAfter)) &&
    (!archiveEnabled || neverStop || neverArchive || filled(archiveAfter));

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          const p = settings.defaultPolicy;
          setFreezeAfter(String(p.freezeAfterSeconds));
          setNeverStop(p.stopAfterSeconds === null);
          setStopAfter(p.stopAfterSeconds ? String(p.stopAfterSeconds) : '');
          setNeverArchive(p.archiveAfterSeconds === null);
          setArchiveAfter(
            p.archiveAfterSeconds ? String(p.archiveAfterSeconds) : '',
          );
          setError(null);
        }
      }}
    >
      <EditTrigger />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{m.settings_policy_dialog_title()}</DialogTitle>
          <DialogDescription>
            {m.settings_policy_dialog_desc()}
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit(
              {
                defaultPolicy: {
                  freezeAfterSeconds: Number(freezeAfter),
                  stopAfterSeconds: neverStop ? null : Number(stopAfter),
                  archiveAfterSeconds:
                    !archiveEnabled || neverStop || neverArchive
                      ? null
                      : Number(archiveAfter),
                },
              },
              m.settings_policy_saved(),
            );
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="settings-freeze-after">
                {m.settings_policy_freeze_label()}
              </FieldLabel>
              <Input
                id="settings-freeze-after"
                type="number"
                min={1}
                value={freezeAfter}
                onChange={(event) => setFreezeAfter(event.target.value)}
              />
              <FieldDescription>
                {m.settings_policy_freeze_desc()}
                {durationHint(freezeAfter) && ` ${durationHint(freezeAfter)}`}
              </FieldDescription>
            </Field>
            <Field orientation="horizontal">
              <Switch
                id="settings-never-stop"
                checked={neverStop}
                onCheckedChange={setNeverStop}
              />
              <FieldLabel htmlFor="settings-never-stop">
                {m.settings_policy_never_stop()}
              </FieldLabel>
            </Field>
            {!neverStop && (
              <Field>
                <FieldLabel htmlFor="settings-stop-after">
                  {m.settings_policy_stop_label()}
                </FieldLabel>
                <Input
                  id="settings-stop-after"
                  type="number"
                  min={1}
                  value={stopAfter}
                  onChange={(event) => setStopAfter(event.target.value)}
                />
                <FieldDescription>
                  {m.settings_policy_stop_desc()}
                  {durationHint(stopAfter) && ` ${durationHint(stopAfter)}`}
                </FieldDescription>
              </Field>
            )}
            {archiveEnabled && !neverStop && (
              <>
                <Field orientation="horizontal">
                  <Switch
                    id="settings-never-archive"
                    checked={neverArchive}
                    onCheckedChange={setNeverArchive}
                  />
                  <FieldLabel htmlFor="settings-never-archive">
                    {m.settings_policy_never_archive()}
                  </FieldLabel>
                </Field>
                {!neverArchive && (
                  <Field>
                    <FieldLabel htmlFor="settings-archive-after">
                      {m.settings_policy_archive_label()}
                    </FieldLabel>
                    <Input
                      id="settings-archive-after"
                      type="number"
                      min={1}
                      value={archiveAfter}
                      onChange={(event) => setArchiveAfter(event.target.value)}
                    />
                    <FieldDescription>
                      {m.settings_policy_archive_desc()}
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

export function RuntimeSettingsCard({ data }: { data: GetConfigResponse }) {
  const { settings } = data;
  return (
    <section className="shrink-0 overflow-hidden rounded-xl border bg-card">
      <div className="border-b px-4 py-3">
        <h2 className="text-sm font-medium">{m.settings_knobs_title()}</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {m.settings_knobs_desc()}
          {settings.updatedAt
            ? m.settings_knobs_last_modified({
                time: new Date(settings.updatedAt).toLocaleString(),
              })
            : m.settings_knobs_never_modified()}
        </p>
      </div>
      <div className="divide-y">
        <EditRow
          label={m.settings_row_max_sandboxes()}
          value={m.settings_row_max_value({ n: settings.maxSandboxes })}
          dialog={<MaxSandboxesDialog settings={settings} />}
        />
        <EditRow
          label={m.settings_row_defaults()}
          value={m.settings_row_defaults_value({
            cpus: settings.sandboxDefaults.cpus,
            memory: settings.sandboxDefaults.memoryGb,
            disk: settings.sandboxDefaults.diskGb,
          })}
          dialog={<SandboxDefaultsDialog settings={settings} />}
        />
        <EditRow
          label={m.settings_row_policy()}
          value={policyLine(settings.defaultPolicy)}
          dialog={
            <DefaultPolicyDialog
              settings={settings}
              archiveEnabled={data.archive.enabled}
            />
          }
        />
        <EditRow
          label={m.settings_row_swap()}
          value={
            data.swap.supported
              ? swapLine(settings.swapGb, data.swap.activeGb)
              : m.settings_swap_unsupported()
          }
          dialog={
            data.swap.supported ? <SwapDialog settings={settings} /> : undefined
          }
        />
      </div>
    </section>
  );
}
