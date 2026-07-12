import { Download01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from '@/components/ui/empty';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { formatBytes } from '@/lib/format';
import { downloadFile, type EnvdAuth, type EnvdEntry } from '../envd-client';
import { useFileMutations } from '../hooks/useEnvd';

/**
 * 在线看得过来的才在线看:预览上限之上只给下载 — 编辑器不是给日志
 * 大文件准备的。上限取 1 MiB:够看配置、代码、多数日志尾巴,又不至于
 * 把整段内存交给一个 textarea。
 */
const PREVIEW_CAP_BYTES = 1024 * 1024;

/**
 * 文本判定:头 8 KiB 里出现 NUL 字节即视为二进制。与 git 同一招 —
 * 不猜编码不读魔数,便宜且几乎不会冤枉文本文件。
 */
function looksBinary(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, 8192);
  return head.includes(0);
}

/**
 * 点开文件先看内容,小文本顺手改完保存 — 排查 agent 产物最高频的动作,
 * 不该绕道"下载到本地再打开"。读写都走 envd 的文件面(与官方 e2b SDK
 * 同一条 wire):读是 GET /files,存是同路径的整文件覆写上传。
 */
export function FilePreviewDialog({
  auth,
  entry,
  onClose,
}: {
  auth: EnvdAuth | undefined;
  /** 正在预览的文件;null = 关闭。 */
  entry: EnvdEntry | null;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState('');
  const mutations = useFileMutations(auth);
  const tooLarge = entry !== null && Number(entry.size) > PREVIEW_CAP_BYTES;

  const content = useQuery({
    queryKey: ['envdFileContent', auth?.sandboxId, entry?.path],
    queryFn: async () => {
      if (!auth || !entry) throw new Error('缺少 envd 凭证');
      const blob = await downloadFile(auth, entry.path);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (looksBinary(bytes)) return { binary: true as const };
      return { binary: false as const, text: new TextDecoder().decode(bytes) };
    },
    enabled: entry !== null && !tooLarge && auth !== undefined,
    // 文件内容随沙箱里的进程随时在变,每次打开都重读,不吃缓存。
    gcTime: 0,
    staleTime: 0,
    retry: false,
  });

  // 读到文本后灌入编辑区;依赖 entry.path 使换文件时必然重灌。
  useEffect(() => {
    if (content.data && !content.data.binary) {
      setDraft(content.data.text);
    }
  }, [content.data]);

  const dirty =
    content.data !== undefined &&
    !content.data.binary &&
    draft !== content.data.text;

  const download = () => {
    if (!entry) return;
    mutations.download.mutate(
      { path: entry.path, name: entry.name },
      { onError: (error) => toast.error(error.message) },
    );
  };

  const save = () => {
    if (!entry) return;
    mutations.upload.mutate(
      { path: entry.path, file: new File([draft], entry.name) },
      {
        onSuccess: () => {
          toast.success(`已保存 ${entry.name}`);
          onClose();
        },
        onError: (error) => toast.error(error.message),
      },
    );
  };

  return (
    <Dialog
      open={entry !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="font-mono">{entry?.name}</DialogTitle>
          <DialogDescription className="font-mono text-xs">
            {entry?.path} · {formatBytes(Number(entry?.size ?? 0))}
          </DialogDescription>
        </DialogHeader>

        {tooLarge || content.data?.binary ? (
          <Empty className="border border-dashed">
            <EmptyHeader>
              <EmptyTitle>
                {tooLarge ? '文件太大,不在线预览' : '二进制文件,没法当文本看'}
              </EmptyTitle>
              <EmptyDescription>
                {tooLarge
                  ? `在线预览上限 ${formatBytes(PREVIEW_CAP_BYTES)} — 下载后用本地工具打开。`
                  : '内容里有 NUL 字节 — 下载后用对应的工具打开。'}
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button
                variant="outline"
                size="sm"
                disabled={mutations.download.isPending}
                onClick={download}
              >
                <HugeiconsIcon icon={Download01Icon} />
                下载
              </Button>
            </EmptyContent>
          </Empty>
        ) : content.isError ? (
          <Empty className="border border-dashed">
            <EmptyHeader>
              <EmptyTitle>读取失败</EmptyTitle>
              <EmptyDescription>{content.error.message}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : content.isPending ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> 读取文件…
          </div>
        ) : (
          <Textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            spellCheck={false}
            className="h-[55vh] resize-none font-mono text-xs leading-relaxed"
          />
        )}

        {content.data !== undefined && !content.data.binary && (
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              disabled={mutations.download.isPending}
              onClick={download}
            >
              <HugeiconsIcon icon={Download01Icon} />
              下载
            </Button>
            <Button
              size="sm"
              disabled={!dirty || mutations.upload.isPending}
              onClick={save}
            >
              {mutations.upload.isPending && <Spinner />}
              保存
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
