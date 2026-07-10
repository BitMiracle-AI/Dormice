import { ArrowLeft01Icon, Copy01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Link } from '@tanstack/react-router';
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
        aria-label="Copy to clipboard"
        onClick={() =>
          copyText(code).then(
            () => toast.success('Copied'),
            () => toast.error('Copy failed — select the text manually'),
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
  // Dormice extension: the same userKey always returns the same sandbox.
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
    <main className="mx-auto min-h-screen w-full max-w-3xl px-6 pb-10">
      <header className="flex items-center gap-3 py-5">
        <Button
          variant="ghost"
          size="icon-sm"
          nativeButton={false}
          render={<Link to="/" aria-label="Back to sandboxes" />}
        >
          <HugeiconsIcon icon={ArrowLeft01Icon} />
        </Button>
        <h1 className="text-lg font-semibold">Connect</h1>
      </header>

      <p className="mb-6 text-sm text-muted-foreground">
        This daemon is reachable at <code className="font-mono">{origin}</code>{' '}
        — the address you are reading this page from. Every snippet needs the
        daemon's API token; the console never stores it, so read it on the
        daemon host:{' '}
        <code className="font-mono">
          grep ^DORMICE_API_TOKEN /etc/dormice/env
        </code>
      </p>

      <div className="flex flex-col gap-6">
        <Card>
          <CardHeader>
            <CardTitle>E2B SDK</CardTitle>
            <CardDescription>
              The official <code className="font-mono">e2b</code> package works
              as-is — point its two URLs here and prefix your token with{' '}
              <code className="font-mono">e2b_</code>. No other code changes.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Snippet code={e2bSnippet} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Native SDK</CardTitle>
            <CardDescription>
              <code className="font-mono">@dormice/sdk</code> speaks the
              daemon's native RPC — acquire is idempotent by design. Not
              published to npm yet; build it from the repository workspace.
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
              <code className="font-mono">dor</code> (installed alongside the
              daemon by install.sh) reads these two environment variables.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Snippet code={cliSnippet} />
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
