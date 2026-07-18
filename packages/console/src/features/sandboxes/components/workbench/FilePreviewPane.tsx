import type { Sandbox } from '@dormice/shared';
import {
  Download01Icon,
  GlobeIcon,
  RefreshIcon,
} from '@hugeicons/core-free-icons';
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
import {
  downloadFile,
  type EnvdEntry,
  SIGNED_URL_TTL_SECONDS,
  signedDownloadUrl,
} from '../../envd-client';
import { useEnvdAuth, useFileMutations } from '../../hooks/useEnvd';
import { previewKindOf } from '../../preview';

/**
 * 在线看得过来的才在线看:预览上限之上只给下载 — 编辑器不是给日志
 * 大文件准备的。文本上限取 1 MiB:够看配置、代码、多数日志尾巴,又不至于
 * 把整段内存交给一个 textarea。
 */
const PREVIEW_CAP_BYTES = 1024 * 1024;

/**
 * 图片/PDF 的 Blob 预览上限:object URL 是整块驻内存的,50 MiB 够看
 * 截图、图表、报告 PDF;更大的下载本地看。Office 无本地上限 — 我们
 * 不抓取字节,Microsoft 查看器超限会在 iframe 里自己报错,诚实。
 */
const MEDIA_CAP_BYTES = 50 * 1024 * 1024;

/** Microsoft 在线查看器的 iframe 端点,src= 后接 URL 编码的签名直链。 */
const OFFICE_VIEWER = 'https://view.officeapps.live.com/op/embed.aspx?src=';

/**
 * 文本判定:头 8 KiB 里出现 NUL 字节即视为二进制。与 git 同一招 —
 * 不猜编码不读魔数,便宜且几乎不会冤枉文本文件。
 */
function looksBinary(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, 8192);
  return head.includes(0);
}

type PreviewData =
  | { kind: 'text'; text: string }
  | { kind: 'binary' }
  | { kind: 'media'; blob: Blob };

/**
 * 工作台中央的预览/编辑窗格,按 previewKindOf 分流:文本就地编辑保存;
 * 图片/PDF 走 header 认证的 Blob → object URL 就地渲染(同源,明文
 * HTTP 的 IP 访问也能用);Office 文档在显式点击后铸短时效签名直链,
 * 交给 Microsoft 在线查看器抓取渲染 — 内容会离开本机,所以必须是
 * 一次带披露的点击,绝不自动外发。读写都走 envd 的文件面。
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

  const previewKind = selected ? previewKindOf(selected.name) : 'other';
  const isMedia = previewKind === 'image' || previewKind === 'pdf';
  const capBytes = isMedia ? MEDIA_CAP_BYTES : PREVIEW_CAP_BYTES;
  const tooLarge =
    selected !== null &&
    previewKind !== 'office' &&
    Number(selected.size) > capBytes;

  const content = useQuery({
    queryKey: ['envdFileContent', sandbox.id, selected?.path],
    queryFn: async ({ signal }): Promise<PreviewData> => {
      if (!auth.data || !selected) throw new Error('缺少 envd 凭证');
      // signal 让换文件时真取消上一个下载 — media 档 50 MiB 级别,不取消
      // 就是白流量压着新请求。
      const blob = await downloadFile(auth.data, selected.path, signal);
      if (isMedia) {
        // 类型由扩展名裁决(preview.ts 单一来源),不读字节不嗅探;
        // blob.type 来自服务端按扩展名的 MIME 表,浏览器认它渲染。
        return { kind: 'media', blob };
      }
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (looksBinary(bytes)) return { kind: 'binary' };
      return { kind: 'text', text: new TextDecoder().decode(bytes) };
    },
    // Office 分支零本地抓取:浏览器渲染不了 docx,抓了也没用 — 它只铸 URL。
    enabled:
      selected !== null &&
      !tooLarge &&
      auth.data !== undefined &&
      previewKind !== 'office',
    // 文件内容随沙箱里的进程随时在变,每次选中都重读,不吃缓存。
    gcTime: 0,
    staleTime: 0,
    retry: false,
  });

  // object URL 的创建与撤销成对住在同一个 effect:换文件(data 变)、
  // 手动刷新(新 blob)、卸载三条路都自动撤旧,StrictMode 双跑也安全。
  // 绝不挪进 queryFn/select —— gcTime 0 的缓存没有淘汰回调,URL 归缓存
  // 所有就是撤销无主,必漏内存。
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  useEffect(() => {
    if (content.data?.kind !== 'media') return;
    const url = URL.createObjectURL(content.data.blob);
    setObjectUrl(url);
    return () => {
      URL.revokeObjectURL(url);
      setObjectUrl(null);
    };
  }, [content.data]);

  // 读到文本后灌入编辑区;依赖 content.data 使换文件/刷新时必然重灌。
  useEffect(() => {
    if (content.data?.kind === 'text') {
      setDraft(content.data.text);
    }
  }, [content.data]);

  const dirty = content.data?.kind === 'text' && draft !== content.data.text;

  // Office 的已铸直链按 path 记账:换文件后 path 对不上即自然归零,
  // 不用重置 effect;旧条目无害(直链本就 15 分钟自灭)。
  const [office, setOffice] = useState<{ path: string; src: string } | null>(
    null,
  );
  const officeSrc =
    office !== null && selected !== null && office.path === selected.path
      ? office.src
      : null;
  const [minting, setMinting] = useState(false);
  const mintOffice = async () => {
    if (!auth.data || !selected) return;
    setMinting(true);
    try {
      const signed = await signedDownloadUrl(auth.data, selected.path);
      setOffice({
        path: selected.path,
        src: `${OFFICE_VIEWER}${encodeURIComponent(signed)}`,
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setMinting(false);
    }
  };

  if (selected === null) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <Empty>
          <EmptyHeader>
            <EmptyTitle>在左侧选择一个文件</EmptyTitle>
            <EmptyDescription>
              文本在这里预览和编辑,图片、PDF、Office 文档也能看;终端就在
              下面,改完顺手跑。
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

  const downloadButton = (
    <Button
      variant="outline"
      size="sm"
      disabled={mutations.download.isPending}
      onClick={download}
    >
      <HugeiconsIcon icon={Download01Icon} />
      下载
    </Button>
  );

  // 刷新按各形态各表:text/media 重读内容;Office 已铸则重铸直链(新
  // 过期时间 → 新签名 → 新 src,顺带击穿 Microsoft 按 URL 的缓存),
  // 未铸时无物可刷,不渲染。
  const refreshButton =
    previewKind === 'office' ? (
      officeSrc !== null && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="重新生成直链并刷新预览"
          title="重新生成直链并刷新预览"
          disabled={minting}
          onClick={() => void mintOffice()}
        >
          <HugeiconsIcon icon={RefreshIcon} />
        </Button>
      )
    ) : (
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="重新读取"
        disabled={content.isFetching || dirty}
        title={
          dirty ? '有未保存的修改 — 先保存或撤销,刷新会覆盖草稿' : '重新读取'
        }
        onClick={() => void content.refetch()}
      >
        <HugeiconsIcon icon={RefreshIcon} />
      </Button>
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
          {refreshButton}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="下载"
            disabled={mutations.download.isPending}
            onClick={download}
          >
            <HugeiconsIcon icon={Download01Icon} />
          </Button>
          {/* 保存只对文本有意义 — 对一张 png「保存」不是暂不可用,是
              无意义,所以隐藏而非禁用。 */}
          {previewKind === 'other' && (
            <Button
              size="sm"
              className="h-6 px-2 text-xs"
              disabled={!dirty || mutations.upload.isPending}
              onClick={save}
            >
              {mutations.upload.isPending && <Spinner />}
              保存
            </Button>
          )}
        </div>
      </div>

      {previewKind === 'office' ? (
        officeSrc !== null ? (
          // 跨域第三方内容收权:sandbox 白名单是 Microsoft 查看器自己
          // 要的最小集(allow-same-origin 给的是它的 origin 不是我们的);
          // no-referrer 不把控制台路径送出去。
          <iframe
            src={officeSrc}
            title={selected.name}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            referrerPolicy="no-referrer"
            className="min-h-0 w-full flex-1 border-0"
          />
        ) : (
          <div className="flex min-h-0 flex-1 items-center justify-center p-4">
            <Empty>
              <EmptyHeader>
                {window.isSecureContext ? (
                  <>
                    <EmptyTitle>
                      Office 文档 — 可用 Microsoft 在线预览
                    </EmptyTitle>
                    <EmptyDescription>
                      预览会为此文件生成 {SIGNED_URL_TTL_SECONDS / 60}{' '}
                      分钟有效的签名直链,交给
                      Microsoft(view.officeapps.live.com)的服务器抓取并渲染 —
                      文件内容会离开本机。含敏感内容请下载后本地打开。
                    </EmptyDescription>
                  </>
                ) : (
                  <>
                    <EmptyTitle>
                      明文 HTTP 下无法在线预览 Office 文档
                    </EmptyTitle>
                    <EmptyDescription>
                      生成签名直链要用浏览器的加密接口(仅 HTTPS 可用),且
                      Microsoft 的预览服务只能抓取公网 HTTPS 地址 — 请改用绑定的
                      HTTPS 域名访问控制台,或下载后本地打开。
                    </EmptyDescription>
                  </>
                )}
              </EmptyHeader>
              <EmptyContent>
                <div className="flex gap-2">
                  {window.isSecureContext && (
                    <Button
                      size="sm"
                      disabled={minting}
                      onClick={() => void mintOffice()}
                    >
                      {minting ? (
                        <Spinner />
                      ) : (
                        <HugeiconsIcon icon={GlobeIcon} />
                      )}
                      用 Microsoft 在线预览
                    </Button>
                  )}
                  {downloadButton}
                </div>
              </EmptyContent>
            </Empty>
          </div>
        )
      ) : tooLarge || content.data?.kind === 'binary' ? (
        <div className="flex min-h-0 flex-1 items-center justify-center p-4">
          <Empty>
            <EmptyHeader>
              <EmptyTitle>
                {tooLarge ? '文件太大,不在线预览' : '二进制文件,没法当文本看'}
              </EmptyTitle>
              <EmptyDescription>
                {tooLarge
                  ? `${isMedia ? '图片/PDF' : '文本'}在线预览上限 ${formatBytes(capBytes)} — 下载后用本地工具打开。`
                  : '内容里有 NUL 字节 — 下载后用对应的工具打开。'}
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>{downloadButton}</EmptyContent>
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
      ) : content.isPending || (content.data.kind === 'media' && !objectUrl) ? (
        <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
          <Spinner /> 读取文件
        </div>
      ) : content.data.kind === 'media' && objectUrl ? (
        previewKind === 'pdf' ? (
          // 刻意不加 sandbox:Chrome 的内置 PDF 查看器在 sandboxed iframe
          // 里拒载(插件被禁);能进这个分支的只有 .pdf 扩展名 + 自家 MIME
          // 表给的 application/pdf,不存在"其实是 HTML"的升格路径。
          <iframe
            src={objectUrl}
            title={selected.name}
            className="min-h-0 w-full flex-1 border-0"
          />
        ) : (
          <div className="min-h-0 flex-1 overflow-auto p-4">
            {/* svg 也走 <img>:规范保证不执行脚本、不发子请求 — 换成
                iframe/object 等于给沙箱里的文件开脚本执行口。 */}
            <img
              src={objectUrl}
              alt={selected.name}
              className="mx-auto max-w-full"
            />
          </div>
        )
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
