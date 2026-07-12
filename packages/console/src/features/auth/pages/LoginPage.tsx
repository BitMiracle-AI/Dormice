import { useMutation } from '@tanstack/react-query';
import { useSearch } from '@tanstack/react-router';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Field, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { login } from '@/lib/api';
import { setSessionMarker } from '@/lib/session';

/**
 * One field, one button. The token is posted once and comes back as an
 * httpOnly session cookie — it is never stored anywhere the page can read.
 * Success does a full-page jump (not a client-side navigate): the cookie is
 * brand new, and a reload guarantees every query starts from it.
 */
export function LoginPage() {
  const { redirect } = useSearch({ from: '/login' });
  const [token, setToken] = useState('');
  const mutation = useMutation({
    mutationFn: login,
    onSuccess: () => {
      setSessionMarker();
      window.location.href = redirect ?? '/console/';
    },
  });

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-2xl">Dormice</CardTitle>
          <CardDescription>
            粘贴 daemon 的 API token 进入控制台。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              mutation.mutate(token);
            }}
            className="flex flex-col gap-6"
          >
            <Field data-invalid={mutation.isError || undefined}>
              <FieldLabel htmlFor="api-token">API token</FieldLabel>
              <Input
                id="api-token"
                type="password"
                autoFocus
                value={token}
                onChange={(event) => setToken(event.target.value)}
                placeholder="DORMICE_API_TOKEN"
                className="font-mono"
                aria-invalid={mutation.isError || undefined}
              />
              {mutation.isError && (
                <FieldError>{mutation.error.message}</FieldError>
              )}
            </Field>
            <Button
              type="submit"
              disabled={token.length === 0 || mutation.isPending}
              className="w-full"
            >
              {mutation.isPending && <Spinner />}
              登录
            </Button>
            {!window.isSecureContext && (
              // 明文 HTTP 下 token 在链路上裸奔 — 引导期(IP 访问)的已知
              // 取舍,提醒但不拦:绑定域名后这行自然消失。
              <p className="text-xs text-muted-foreground">
                当前连接是明文 HTTP,token 在网络上不加密。建议登录后在
                域名页绑定域名启用 HTTPS。
              </p>
            )}
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
