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
      // 设置页读 config;总览的容量卡走 getHostMetrics 自己的轮询。
      void queryClient.invalidateQueries({ queryKey: ['config'] });
      toast.success(done);
      onDone();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
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
          编辑
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
          <DialogTitle>调整沙箱容量上限</DialogTitle>
          <DialogDescription>
            只挡新建(撞上回 429),唤醒永不受限。这是一根防失控的保险丝 —
            拔太高之后,物理磁盘就是唯一兜底,记得盯总览页的数据盘水位。
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit(
              { maxSandboxes: Number(value) },
              `容量上限已改为 ${Number(value)}`,
            );
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="settings-max-sandboxes">
                最多同时存在的沙箱数
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
              保存
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
          <DialogTitle>调整新沙箱的默认配额</DialogTitle>
          <DialogDescription>
            CPU/内存在下一次容器出生时生效(含停止后冷启动的存量沙箱);
            磁盘在磁盘出生时定型(首次创建与归档恢复) —
            磁盘是沙箱的本体,永不原地改尺寸,调小前注意别小于归档沙箱的真实内容。
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
              '新沙箱默认配额已更新',
            );
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="settings-cpus">CPU(核)</FieldLabel>
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
              <FieldLabel htmlFor="settings-memory">内存(GiB)</FieldLabel>
              <Input
                id="settings-memory"
                type="number"
                min={0.1}
                step="any"
                value={memoryGb}
                onChange={(event) => setMemoryGb(event.target.value)}
              />
              <FieldDescription>
                沙箱内超限 OOM 会让整箱退出(对账救回),给 agent 留点余量。
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="settings-disk">磁盘(GiB)</FieldLabel>
              <Input
                id="settings-disk"
                type="number"
                min={1}
                step="any"
                value={diskGb}
                onChange={(event) => setDiskGb(event.target.value)}
              />
              <FieldDescription>
                名义配额:稀疏镜像只为真实写入付费,超卖靠数据盘水位观察。
              </FieldDescription>
            </Field>
            {error && <FieldError>{error}</FieldError>}
          </FieldGroup>
          <DialogFooter className="mt-6">
            <Button type="submit" disabled={!valid || pending}>
              {pending && <Spinner />}
              保存
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
          <DialogTitle>调整追加 swap 空间</DialogTitle>
          <DialogDescription>
            swap 容量 ≈ 能同时冬眠多少沙箱内存(冻结把内存挤进 swap)。
            调大立即生效;调小要等下次重启宿主 — 正在用的 swap
            绝不强拆,那会把冬眠沙箱的内存全拽回物理内存。
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit(
              { swapGb: Number(value) },
              `追加 swap 目标已改为 ${Number(value)} GiB`,
            );
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="settings-swap-gb">
                Dormice 管理的 swap 总量(GiB)
              </FieldLabel>
              <Input
                id="settings-swap-gb"
                type="number"
                min={0}
                value={value}
                onChange={(event) => setValue(event.target.value)}
              />
              <FieldDescription>
                在系统自带 swap 之外追加,0 = 不追加。swap
                文件真实占据数据盘空间(不是稀疏的),调大前看一眼总览页的数据盘水位。
              </FieldDescription>
            </Field>
            {error && <FieldError>{error}</FieldError>}
          </FieldGroup>
          <DialogFooter className="mt-6">
            <Button type="submit" disabled={!valid || pending}>
              {pending && <Spinner />}
              保存
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
    return `目标 ${targetGb} GiB · 当前挂载 ${activeGb} GiB — 缩容在下次重启宿主时生效`;
  }
  if (activeGb < targetGb) {
    return `目标 ${targetGb} GiB · 当前挂载 ${activeGb} GiB — 增容未完成,详见 daemon 日志`;
  }
  return `${targetGb} GiB(系统自带 swap 另计)`;
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
          <DialogTitle>调整默认生命周期策略</DialogTitle>
          <DialogDescription>
            只影响之后 acquire 新建的沙箱 — 存量沙箱各有各的策略,去沙箱
            列表批量调。
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
              '默认生命周期策略已更新',
            );
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="settings-freeze-after">
                空闲多久后冻结(秒)
              </FieldLabel>
              <Input
                id="settings-freeze-after"
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
                id="settings-never-stop"
                checked={neverStop}
                onCheckedChange={setNeverStop}
              />
              <FieldLabel htmlFor="settings-never-stop">
                永不停止(常驻 agent)
              </FieldLabel>
            </Field>
            {!neverStop && (
              <Field>
                <FieldLabel htmlFor="settings-stop-after">
                  空闲多久后停止(秒)
                </FieldLabel>
                <Input
                  id="settings-stop-after"
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
            {archiveEnabled && !neverStop && (
              <>
                <Field orientation="horizontal">
                  <Switch
                    id="settings-never-archive"
                    checked={neverArchive}
                    onCheckedChange={setNeverArchive}
                  />
                  <FieldLabel htmlFor="settings-never-archive">
                    永不归档
                  </FieldLabel>
                </Field>
                {!neverArchive && (
                  <Field>
                    <FieldLabel htmlFor="settings-archive-after">
                      空闲多久后归档(秒)
                    </FieldLabel>
                    <Input
                      id="settings-archive-after"
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
            {error && <FieldError>{error}</FieldError>}
          </FieldGroup>
          <DialogFooter className="mt-6">
            <Button type="submit" disabled={!valid || pending}>
              {pending && <Spinner />}
              保存
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
        <h2 className="text-sm font-medium">运营旋钮</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          住在账本里,改了立即生效,不用重启 —
          下表同名环境变量只是首次启动的种子值。
          {settings.updatedAt
            ? `最后修改于 ${new Date(settings.updatedAt).toLocaleString()}。`
            : '从未改过,仍是种子值。'}
        </p>
      </div>
      <div className="divide-y">
        <EditRow
          label="沙箱容量上限"
          value={`${settings.maxSandboxes} 个(只挡新建,唤醒永不受限)`}
          dialog={<MaxSandboxesDialog settings={settings} />}
        />
        <EditRow
          label="新沙箱默认配额"
          value={`${settings.sandboxDefaults.cpus} CPU · ${settings.sandboxDefaults.memoryGb} GiB 内存 · ${settings.sandboxDefaults.diskGb} GiB 磁盘`}
          dialog={<SandboxDefaultsDialog settings={settings} />}
        />
        <EditRow
          label="默认生命周期策略"
          value={policyLine(settings.defaultPolicy)}
          dialog={
            <DefaultPolicyDialog
              settings={settings}
              archiveEnabled={data.archive.enabled}
            />
          }
        />
        <EditRow
          label="追加 swap 空间"
          value={
            data.swap.supported
              ? swapLine(settings.swapGb, data.swap.activeGb)
              : '本宿主不支持(需要 Linux 宿主 + docker 执行器)'
          }
          dialog={
            data.swap.supported ? <SwapDialog settings={settings} /> : undefined
          }
        />
      </div>
    </section>
  );
}
