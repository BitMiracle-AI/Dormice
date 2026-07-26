import { Snippet } from '@/components/Snippet';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { m } from '@/paraglide/messages';
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
        <h1 className="text-xl font-medium">{m.connect_title()}</h1>
      </div>
      <p className="mb-6 text-sm text-muted-foreground">
        {m.connect_intro_1()}
        <code className="font-mono">{origin}</code>
        {m.connect_intro_2()}{' '}
        <code className="font-mono">
          grep ^DORMICE_API_TOKEN /etc/dormice/env
        </code>
      </p>

      <div className="flex flex-col gap-6">
        <Card>
          <CardHeader>
            <CardTitle>E2B SDK</CardTitle>
            <CardDescription>
              {m.connect_e2b_desc_1()}
              <code className="font-mono">e2b</code>
              {m.connect_e2b_desc_2()}
              <code className="font-mono">e2b_</code>
              {m.connect_e2b_desc_3()}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Snippet code={e2bSnippet(origin)} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{m.connect_sdk_title()}</CardTitle>
            <CardDescription>
              <code className="font-mono">@dormice/sdk</code>
              {m.connect_sdk_desc()}
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
              <code className="font-mono">dor</code>
              {m.connect_cli_desc()}
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
