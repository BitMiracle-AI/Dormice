import type { GetConfigResponse, S3ArchiveView } from '@dormice/shared';
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
import { m } from '@/paraglide/messages';
import { useUpdateSettings } from '../hooks/useUpdateSettings';

/**
 * 归档存储(S3)卡:六字段撑不进运营旋钮卡的一行一弹窗形制,所以独立
 * 成卡,视觉沿用同一张皮。语义要点都摆在明面上:两把钥匙保存后永不回
 * 显(wire 恒不回传),编辑时必须重新输入 — 这不是缺陷,是"界面上看到
 * 什么就写下什么"的整组替换规矩对密钥的诚实版本;保存前 daemon 会对
 * 桶做一次真实的写-读-删探针,坏凭据/坏端点当场报 S3 原话、绝不落账;
 * 有沙箱归档在当前存储里时,清除或换端点/桶会被 daemon 拒绝并点名数量。
 */

function fieldStates(s3: S3ArchiveView | null) {
  return {
    endpoint: s3?.endpoint ?? '',
    bucket: s3?.bucket ?? '',
    region: s3?.region ?? 'us-east-1',
    forcePathStyle: s3?.forcePathStyle ?? false,
  };
}

function ConfigureDialog({
  s3,
  trigger,
}: {
  s3: S3ArchiveView | null;
  trigger: React.ReactElement;
}) {
  const [open, setOpen] = useState(false);
  const [endpoint, setEndpoint] = useState('');
  const [bucket, setBucket] = useState('');
  const [region, setRegion] = useState('');
  const [forcePathStyle, setForcePathStyle] = useState(false);
  const [accessKeyId, setAccessKeyId] = useState('');
  const [secretAccessKey, setSecretAccessKey] = useState('');
  const { pending, error, setError, submit } = useUpdateSettings(() =>
    setOpen(false),
  );

  const valid =
    /^https?:\/\/.+/.test(endpoint.trim()) &&
    bucket.trim() !== '' &&
    region.trim() !== '' &&
    accessKeyId !== '' &&
    secretAccessKey !== '';

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          const initial = fieldStates(s3);
          setEndpoint(initial.endpoint);
          setBucket(initial.bucket);
          setRegion(initial.region);
          setForcePathStyle(initial.forcePathStyle);
          // 两把钥匙恒空白:服务端从不回传,预填无从谈起。
          setAccessKeyId('');
          setSecretAccessKey('');
          setError(null);
        }
      }}
    >
      <DialogTrigger render={trigger} />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {s3
              ? m.settings_archive_dialog_edit_title()
              : m.settings_archive_dialog_title()}
          </DialogTitle>
          <DialogDescription>
            {m.settings_archive_dialog_desc()}
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit(
              {
                s3: {
                  endpoint: endpoint.trim(),
                  bucket: bucket.trim(),
                  region: region.trim(),
                  forcePathStyle,
                  accessKeyId,
                  secretAccessKey,
                },
              },
              m.settings_archive_saved({ bucket: bucket.trim() }),
            );
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="archive-endpoint">
                {m.settings_archive_endpoint_label()}
              </FieldLabel>
              <Input
                id="archive-endpoint"
                value={endpoint}
                onChange={(event) => setEndpoint(event.target.value)}
                placeholder="https://s3.example.com"
                className="font-mono"
              />
              <FieldDescription>
                {m.settings_archive_endpoint_desc()}
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="archive-bucket">
                {m.settings_archive_bucket_label()}
              </FieldLabel>
              <Input
                id="archive-bucket"
                value={bucket}
                onChange={(event) => setBucket(event.target.value)}
                className="font-mono"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="archive-region">
                {m.settings_archive_region_label()}
              </FieldLabel>
              <Input
                id="archive-region"
                value={region}
                onChange={(event) => setRegion(event.target.value)}
                placeholder="us-east-1"
                className="font-mono"
              />
            </Field>
            <Field orientation="horizontal">
              <Switch
                id="archive-path-style"
                checked={forcePathStyle}
                onCheckedChange={setForcePathStyle}
              />
              <FieldLabel htmlFor="archive-path-style">
                {m.settings_archive_path_style_label()}
              </FieldLabel>
            </Field>
            <FieldDescription>
              {m.settings_archive_path_style_desc()}
            </FieldDescription>
            <Field>
              <FieldLabel htmlFor="archive-access-key">
                {m.settings_archive_ak_label()}
              </FieldLabel>
              <Input
                id="archive-access-key"
                value={accessKeyId}
                onChange={(event) => setAccessKeyId(event.target.value)}
                autoComplete="off"
                className="font-mono"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="archive-secret-key">
                {m.settings_archive_sk_label()}
              </FieldLabel>
              <Input
                id="archive-secret-key"
                type="password"
                value={secretAccessKey}
                onChange={(event) => setSecretAccessKey(event.target.value)}
                autoComplete="new-password"
              />
              <FieldDescription>
                {m.settings_archive_keys_desc()}
              </FieldDescription>
            </Field>
            {error && <FieldError>{error}</FieldError>}
          </FieldGroup>
          <DialogFooter className="mt-6">
            <Button type="submit" disabled={!valid || pending}>
              {pending && <Spinner />}
              {pending
                ? m.settings_archive_probing()
                : m.settings_archive_submit()}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DisableDialog() {
  const [open, setOpen] = useState(false);
  const { pending, error, setError, submit } = useUpdateSettings(() =>
    setOpen(false),
  );
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setError(null);
      }}
    >
      <DialogTrigger
        render={
          <Button variant="ghost" size="sm">
            {m.settings_archive_disable()}
          </Button>
        }
      />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{m.settings_archive_disable_title()}</DialogTitle>
          <DialogDescription>
            {m.settings_archive_disable_desc()}
          </DialogDescription>
        </DialogHeader>
        {error && <FieldError>{error}</FieldError>}
        <DialogFooter className="mt-2">
          <Button
            variant="destructive"
            disabled={pending}
            onClick={() =>
              void submit({ s3: null }, m.settings_archive_disabled_toast())
            }
          >
            {pending && <Spinner />}
            {m.settings_archive_disable()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ArchiveStoreCard({ data }: { data: GetConfigResponse }) {
  const s3 = data.settings.s3;
  return (
    <section className="shrink-0 overflow-hidden rounded-xl border bg-card">
      <div className="border-b px-4 py-3">
        <h2 className="text-sm font-medium">
          {m.settings_archive_card_title()}
        </h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {m.settings_archive_card_desc()}
        </p>
      </div>
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        {s3 ? (
          <>
            <div className="min-w-0">
              <div
                className="truncate font-mono text-sm"
                title={`${s3.endpoint} · ${s3.bucket}`}
              >
                {s3.endpoint} · {s3.bucket}
              </div>
              <div className="mt-0.5 text-sm text-muted-foreground">
                {m.settings_archive_summary({
                  region: s3.region,
                  pathStyle: s3.forcePathStyle
                    ? m.settings_archive_path_style_on()
                    : m.settings_archive_path_style_off(),
                })}
                {/* 归档已启用但默认策略永不归档:直说,别让用户以为配完就完了。 */}
                {data.archive.defaultSeconds === null &&
                  ` ${m.settings_archive_policy_reminder()}`}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <ConfigureDialog
                s3={s3}
                trigger={
                  <Button variant="outline" size="sm">
                    <HugeiconsIcon icon={PencilEdit02Icon} />
                    {m.common_edit()}
                  </Button>
                }
              />
              <DisableDialog />
            </div>
          </>
        ) : (
          <>
            <div className="text-sm text-muted-foreground">
              {m.settings_archive_not_configured()}
            </div>
            <ConfigureDialog
              s3={null}
              trigger={
                <Button variant="outline" size="sm">
                  {m.settings_archive_configure()}
                </Button>
              }
            />
          </>
        )}
      </div>
    </section>
  );
}
