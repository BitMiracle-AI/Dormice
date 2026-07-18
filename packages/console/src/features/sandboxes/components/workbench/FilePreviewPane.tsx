import type { Sandbox } from '@dormice/shared';
import { Download01Icon, RefreshIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
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
import { downloadFile, type EnvdEntry } from '../../envd-client';
import { useEnvdAuth, useFileMutations } from '../../hooks/useEnvd';

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
 * 工作台中央的预览/编辑窗格:点开文件先看内容,小文本顺手改完保存 —
 * 排查 agent 产物最高频的动作。读写都走 envd 的文件面(读 GET /files,
 * 存同路径整文件覆写上传)。
 *
 * 内容是「打开时快照 + 手动刷新」,刻意不跟 watch 自动重读:agent 每
 * 秒追写日志会冲掉正在编辑的草稿 — 快照语义才编辑得安稳。文件在沙箱
 * 里被删/改名时,下一次读或刷新以诚实的错误态收场,不猜。
 */
export function FilePreviewPane({
  sandbox,
  selected,
  onClear,
}: {
  sandbox: Sandbox;
  /** 正在预览的文件;null = 空态。 */
  selected: EnvdEntry | null;
  /** 错误态里「清除选择」的出口。 */
  onClear: () => void;
}) {
  const auth = useEnvdAuth(sandbox.id);
  const [draft, setDraft] = useState('');
  const mutations = useFileMutations(auth.data);
  const tooLarge =
    selected !== null && Number(selected.size) > PREVIEW_CAP_BYTES;

  const content = useQuery({
    queryKey: ['envdFileContent', sandbox.id, selected?.path],
    queryFn: async () => {
      if (!auth.data || !selected) throw new Error('缺少 envd 凭证');
      const blob = await downloadFile(auth.data, selected.path);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (looksBinary(bytes)) return { binary: true as const };
      return { binary: false as const, text: new TextDecoder().decode(bytes) };
    },
    enabled: selected !== null && !tooLarge && auth.data !== undefined,
    // 文件内容随沙箱里的进程随时在变,每次选中都重读,不吃缓存。
    gcTime: 0,
    staleTime: 0,
    retry: false,
  });

  // 读到文本后灌入编辑区;依赖 content.data 使换文件/刷新时必然重灌。
  useEffect(() => {
    if (content.data && !content.data.binary) {
      setDraft(content.data.text);
    }
  }, [content.data]);

  const dirty =
    content.data !== undefined &&
    !content.data.binary &&
    draft !== content.data.text;

  if (selected === null) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <Empty>
          <EmptyHeader>
            <EmptyTitle>在左侧选择一个文件</EmptyTitle>
            <EmptyDescription>
              文本文件在这里预览和编辑;终端就在下面,改完顺手跑。
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }

  const download = () =>
    mutations.download.mutate(
      { path: selected.path, name: selected.name },
      { onError: (error) => toast.error(error.message) },
    );

  const save = () =>
    mutations.upload.mutate(
      { path: selected.path, file: new File([draft], selected.name) },
      {
        onSuccess: () => {
          toast.success(`已保存 ${selected.name}`);
          // 窗格常驻(弹窗是关了了事),重读一次把保存结果立为新基线,
          // dirty 自然归零。
          void content.refetch();
        },
        onError: (error) => toast.error(error.message),
      },
    );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-1.5">
        <span
          className="min-w-0 truncate font-mono text-xs text-muted-foreground"
          title={selected.path}
        >
          <span className="font-medium text-foreground">{selected.name}</span>
          {' · '}
          {formatBytes(Number(selected.size))}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="重新读取"
            disabled={content.isFetching || dirty}
            title={
              dirty
                ? '有未保存的修改 — 先保存或撤销,刷新会覆盖草稿'
                : '重新读取'
            }
            onClick={() => void content.refetch()}
          >
            <HugeiconsIcon icon={RefreshIcon} />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="下载"
            disabled={mutations.download.isPending}
            onClick={download}
          >
            <HugeiconsIcon icon={Download01Icon} />
          </Button>
          <Button
            size="sm"
            className="h-6 px-2 text-xs"
            disabled={!dirty || mutations.upload.isPending}
            onClick={save}
          >
            {mutations.upload.isPending && <Spinner />}
            保存
          </Button>
        </div>
      </div>

      {tooLarge || content.data?.binary ? (
        <div className="flex min-h-0 flex-1 items-center justify-center p-4">
          <Empty>
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
        </div>
      ) : content.isError ? (
        <div className="flex min-h-0 flex-1 items-center justify-center p-4">
          <Empty>
            <EmptyHeader>
              <EmptyTitle>读取失败 — 文件可能已被删除或改名</EmptyTitle>
              <EmptyDescription>{content.error.message}</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void content.refetch()}
                >
                  重试
                </Button>
                <Button variant="ghost" size="sm" onClick={onClear}>
                  清除选择
                </Button>
              </div>
            </EmptyContent>
          </Empty>
        </div>
      ) : content.isPending ? (
        <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
          <Spinner /> 读取文件
        </div>
      ) : (
        <div className="min-h-0 flex-1 p-2">
          {/* base-ui Textarea 默认 field-sizing-content 随内容长高,
              定高窗格必须钉死(RULES/前端.md 已知坑)。 */}
          <Textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            spellCheck={false}
            className="h-full field-sizing-fixed resize-none overflow-y-auto font-mono text-xs leading-relaxed"
          />
        </div>
      )}
    </div>
  );
}
