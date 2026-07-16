import { Snippet } from '@/components/Snippet';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { cliSnippet, e2bSnippet, sdkSnippet } from '../snippets';

/**
 * Read-only connection instructions. The endpoint is simply this page's
 * origin — the daemon serves the console itself, so however the browser
 * reached it (tunnel, reverse proxy, localhost) is exactly how the SDK
 * should. The token is never shown: the console traded it for an httpOnly
 * cookie at sign-in and cannot read it back.
 */
export function ConnectPage() {
  const origin = window.location.origin;

  return (
    <div className="mx-auto w-full max-w-3xl p-4 md:p-6">
      <div className="mb-1">
        <h1 className="text-xl font-medium">连接</h1>
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
            <Snippet code={e2bSnippet(origin)} />
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
            <Snippet code={sdkSnippet(origin)} />
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
            <Snippet code={cliSnippet(origin)} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
