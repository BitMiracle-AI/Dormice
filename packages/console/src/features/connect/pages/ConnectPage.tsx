import { Copy01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

/**
 * The Clipboard API only exists in secure contexts, and this console is
 * deliberately reachable over plain http during the pre-TLS phase — the
 * textarea trick is the one copy mechanism browsers still allow there.
 */
function copyText(text: string): Promise<void> {
  if (navigator.clipboard) {
    return navigator.clipboard.writeText(text);
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  return copied ? Promise.resolve() : Promise.reject(new Error('copy failed'));
}

function Snippet({ code }: { code: string }) {
  return (
    <div className="relative rounded-md border bg-muted/30">
      <Button
        variant="ghost"
        size="icon-sm"
        className="absolute top-1.5 right-1.5"
        aria-label="复制到剪贴板"
        onClick={() =>
          copyText(code).then(
            () => toast.success('已复制'),
            () => toast.error('复制失败 — 请手动选中文本'),
          )
        }
      >
        <HugeiconsIcon icon={Copy01Icon} />
      </Button>
      <pre className="overflow-x-auto p-4 pr-12 font-mono text-xs leading-relaxed">
        <code>{code}</code>
      </pre>
    </div>
  );
}

/**
 * Read-only connection instructions. The endpoint is simply this page's
 * origin — the daemon serves the console itself, so however the browser
 * reached it (tunnel, reverse proxy, localhost) is exactly how the SDK
 * should. The token is never shown: the console traded it for an httpOnly
 * cookie at sign-in and cannot read it back.
 */
export function ConnectPage() {
  const origin = window.location.origin;

  const e2bSnippet = `import { Sandbox } from 'e2b';

const sandbox = await Sandbox.create({
  apiKey: 'e2b_<your API token>',
  apiUrl: '${origin}/e2b/api',
  sandboxUrl: '${origin}/e2b/envd',
  // Dormice 扩展:同一个 userKey 永远回到同一个沙箱。
  metadata: { userKey: 'my-project' },
});

const result = await sandbox.commands.run('echo hello from dormice');`;

  const sdkSnippet = `import { Dormice } from '@dormice/sdk';

const client = new Dormice({
  endpoint: '${origin}',
  token: '<your API token>',
});

await client.acquireSandbox('my-project');
const result = await client.execCommand('my-project', 'echo hello');`;

  const cliSnippet = `export DORMICE_ENDPOINT=${origin}
export DORMICE_API_TOKEN=<your API token>

dor sandbox ls
dor sandbox exec my-project 'uname -r'`;

  return (
    <div className="mx-auto w-full max-w-3xl">
      <div className="mb-1">
        <h1 className="text-lg font-semibold">连接</h1>
      </div>
      <p className="mb-6 text-sm text-muted-foreground">
        这个 daemon 的地址是 <code className="font-mono">{origin}</code> —
        就是你此刻打开本页用的地址。每段代码都需要 daemon 的 API token;
        控制台从不保存它,去 daemon 主机上读:{' '}
        <code className="font-mono">
          grep ^DORMICE_API_TOKEN /etc/dormice/env
        </code>
      </p>

      <div className="flex flex-col gap-6">
        <Card>
          <CardHeader>
            <CardTitle>E2B SDK</CardTitle>
            <CardDescription>
              官方 <code className="font-mono">e2b</code> 包原样可用 — 把两个
              URL 指到这里,token 加 <code className="font-mono">e2b_</code>{' '}
              前缀,别的代码一行不改。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Snippet code={e2bSnippet} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>原生 SDK</CardTitle>
            <CardDescription>
              <code className="font-mono">@dormice/sdk</code> 说 daemon 的 原生
              RPC — acquire 天生幂等。尚未发布到 npm,从仓库 workspace 构建使用。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Snippet code={sdkSnippet} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>CLI</CardTitle>
            <CardDescription>
              <code className="font-mono">dor</code>(install.sh 随 daemon
              一起装的)读这两个环境变量。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Snippet code={cliSnippet} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
