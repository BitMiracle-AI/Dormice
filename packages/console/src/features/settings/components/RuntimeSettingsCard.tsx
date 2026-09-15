import type { GetConfigResponse, RuntimeSettings } from '@dormice/shared';
import { PIDS_LIMIT_MIN } from '@dormice/shared';
import { PencilEdit02Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useState } from 'react';
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
import { formatDateTime } from '@/lib/datetime';
import { m } from '@/paraglide/messages';
import { useUpdateSettings } from '../hooks/useUpdateSettings';

/**
 * 运营旋钮的编辑区:值住在账本里(env 同名变量只是首次启动的种子),
 * updateSettings 一改立即生效 — 不重启 daemon、不碰任何沙箱。四组各配
 * 一个弹窗,给哪组就整组替换(updatePolicy 的规矩:界面上看到什么就写
 * 下什么)。改的是"之后"不是"已经":容量上限管下一次创建,默认配额管
 * 下一次出生的磁盘/容器,默认策略管下一次 acquire 创建的沙箱 — 存量
 * 沙箱一根汗毛都不动,这句话在每个弹窗里都说清。两个例外:pids 上限会
 * 触达存量沙箱 — 保存时就地扫一遍运行中的壳(docker update,箱内无感),
 * 冻结/停止的在下一次唤醒跟上,都不重建;基础镜像(2026-09-15 刀 4 从
 * 节点 env 升为舰队设置)改了=给基底换代,存量无模板沙箱在下一次冷唤醒
 * 换壳跟上,与模板重指同一语义,弹窗照实说。归档存储与沙箱域名不在这张卡:
 * 前者是独立的归档卡(六字段撑不进一行的形制),后者语义归域名页。追加
 * swap 是每台机器自己的旋钮,2026-09-14 随集群刀 2 搬去节点页(刀 3)。
 */

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

function SandboxDefaultsDialog({ settings }: { settings: RuntimeSettings }) {
  const [open, setOpen] = useState(false);
  const [cpus, setCpus] = useState('');
  const [memoryGb, setMemoryGb] = useState('');
  const [diskGb, setDiskGb] = useState('');
  const { pending, error, setError, submit } = useUpdateSettings(() =>
    setOpen(false),
  );

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

/**
 * pids 上限:与容量上限同形的单数字弹窗。下限 PIDS_LIMIT_MIN 与 wire 同一
 * 常量(shared),前端只做同款校验不另立数字;不设"无上限"选项 — 这道闸
 * 是 fork 炸弹只炸自己箱的物理保证,弹窗文案说清 gVisor 下它不是箱内进程数。
 */
function PidsLimitDialog({ settings }: { settings: RuntimeSettings }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const { pending, error, setError, submit } = useUpdateSettings(() =>
    setOpen(false),
  );

  const valid =
    value.trim() !== '' &&
    Number.isInteger(Number(value)) &&
    Number(value) >= PIDS_LIMIT_MIN;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setValue(String(settings.pidsLimit));
          setError(null);
        }
      }}
    >
      <EditTrigger />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{m.settings_pids_dialog_title()}</DialogTitle>
          <DialogDescription>{m.settings_pids_dialog_desc()}</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit(
              { pidsLimit: Number(value) },
              m.settings_pids_saved({ value: Number(value) }),
            );
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="settings-pids-limit">
                {m.settings_pids_label()}
              </FieldLabel>
              <Input
                id="settings-pids-limit"
                type="number"
                min={PIDS_LIMIT_MIN}
                value={value}
                onChange={(event) => setValue(event.target.value)}
              />
              <FieldDescription>
                {m.settings_pids_field_desc({ min: PIDS_LIMIT_MIN })}
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
  const { pending, error, setError, submit } = useUpdateSettings(() =>
    setOpen(false),
  );

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

/**
 * 基础镜像:单字段弹窗。校验只有"像一个镜像引用"(非空、无空格)— 网关
 * 不查镜像存在性(注册模板也不查:镜像可以晚于配置出现,节点缺它时从舰
 * 队仓库拉),前端更不该替它猜。
 */
function BaseImageDialog({ settings }: { settings: RuntimeSettings }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const { pending, error, setError, submit } = useUpdateSettings(() =>
    setOpen(false),
  );

  const trimmed = value.trim();
  const valid = trimmed !== '' && !/\s/.test(trimmed);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setValue(settings.baseImage ?? '');
          setError(null);
        }
      }}
    >
      <EditTrigger />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{m.settings_base_image_dialog_title()}</DialogTitle>
          <DialogDescription>
            {m.settings_base_image_dialog_desc()}
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit(
              { baseImage: trimmed },
              m.settings_base_image_saved({ image: trimmed }),
            );
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="settings-base-image">
                {m.settings_base_image_label()}
              </FieldLabel>
              <Input
                id="settings-base-image"
                value={value}
                spellCheck={false}
                onChange={(event) => setValue(event.target.value)}
              />
              <FieldDescription>
                {m.settings_base_image_field_desc()}
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

/** 基础镜像那一行的值:设了就说节点缺它时去哪拉;没设就说各节点在靠自己的 env。 */
function baseImageLine(settings: RuntimeSettings): string {
  if (settings.baseImage === null) return m.settings_base_image_unset();
  return settings.registryAddress === null
    ? m.settings_row_base_image_local({ image: settings.baseImage })
    : m.settings_row_base_image_registry({
        image: settings.baseImage,
        registry: settings.registryAddress,
      });
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
                time: formatDateTime(settings.updatedAt),
              })
            : m.settings_knobs_never_modified()}
        </p>
      </div>
      <div className="divide-y">
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
          label={m.settings_row_pids()}
          value={m.settings_row_pids_value({ n: settings.pidsLimit })}
          dialog={<PidsLimitDialog settings={settings} />}
        />
        <EditRow
          label={m.settings_row_base_image()}
          value={baseImageLine(settings)}
          dialog={<BaseImageDialog settings={settings} />}
        />
      </div>
    </section>
  );
}
