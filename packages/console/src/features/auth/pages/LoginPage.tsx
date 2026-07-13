import { useMutation, useQuery } from '@tanstack/react-query';
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
import { ApiError, authStatus, login, setup } from '@/lib/api';
import { setSessionMarker } from '@/lib/session';

/**
 * One page, two forms, forked by whether the account exists. First run
 * shows initialization (API token as proof of ownership + choose the
 * credentials — the token requirement is what closes the "first visitor
 * becomes admin" race); afterwards it is username + password. Re-running
 * initialization is also the forgot-password path, hence the hint below
 * the login form.
 *
 * Success does a full-page jump (not a client-side navigate): the cookie is
 * brand new, and a reload guarantees every query starts from it.
 */
export function LoginPage() {
  const { redirect } = useSearch({ from: '/login' });
  const status = useQuery({ queryKey: ['authStatus'], queryFn: authStatus });
  // Forgot password: the same setup form, entered deliberately — the API
  // token overwrites the account, so reset needs no flow of its own.
  const [resetting, setResetting] = useState(false);

  const enter = () => {
    setSessionMarker();
    window.location.href = redirect ?? '/console/';
  };

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        {status.isPending ? (
          <CardContent className="flex justify-center py-10">
            <Spinner />
          </CardContent>
        ) : status.isError ? (
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            无法连接 daemon：{status.error.message}
          </CardContent>
        ) : status.data.accountExists && !resetting ? (
          <LoginForm onSuccess={enter} onForgot={() => setResetting(true)} />
        ) : (
          <SetupForm
            onSuccess={enter}
            onBack={resetting ? () => setResetting(false) : undefined}
          />
        )}
      </Card>
    </main>
  );
}

// The wire speaks English by design; the Chinese is UI copy, translated at
// the edge — the same rule the activity page follows.
function errorText(error: unknown, invalidCredential: string): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return invalidCredential;
    if (error.status === 409) return '账号尚未初始化，请刷新页面完成初始化。';
    if (error.status === 429) {
      const seconds = /retry in (\d+)s/.exec(error.message)?.[1];
      return seconds
        ? `失败次数过多，请 ${seconds} 秒后再试。`
        : '失败次数过多，请稍后再试。';
    }
  }
  return error instanceof Error ? error.message : String(error);
}

function InsecureContextHint() {
  if (window.isSecureContext) return null;
  return (
    // 明文 HTTP 下凭证在链路上裸奔 — 引导期(IP 访问)的已知取舍,
    // 提醒但不拦:绑定域名后这行自然消失。
    <p className="text-xs text-muted-foreground">
      当前连接是明文 HTTP,凭证在网络上不加密。建议登录后在域名页绑定域名启用
      HTTPS。
    </p>
  );
}

function LoginForm({
  onSuccess,
  onForgot,
}: {
  onSuccess: () => void;
  onForgot: () => void;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const mutation = useMutation({ mutationFn: login, onSuccess });

  return (
    <>
      <CardHeader>
        <CardTitle className="text-2xl">Dormice</CardTitle>
        <CardDescription>输入账号密码进入控制台。</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            mutation.mutate({ username, password });
          }}
          className="flex flex-col gap-6"
        >
          <Field>
            <FieldLabel htmlFor="username">用户名</FieldLabel>
            <Input
              id="username"
              autoFocus
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
          </Field>
          <Field data-invalid={mutation.isError || undefined}>
            <FieldLabel htmlFor="password">密码</FieldLabel>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              aria-invalid={mutation.isError || undefined}
            />
            {mutation.isError && (
              <FieldError>
                {errorText(mutation.error, '用户名或密码不对。')}
              </FieldError>
            )}
          </Field>
          <Button
            type="submit"
            disabled={
              username.length === 0 ||
              password.length === 0 ||
              mutation.isPending
            }
            className="w-full"
          >
            {mutation.isPending && <Spinner />}
            登录
          </Button>
          <button
            type="button"
            onClick={onForgot}
            className="text-xs text-muted-foreground underline-offset-4 hover:underline"
          >
            忘记密码?用 API token 重置账号
          </button>
          <InsecureContextHint />
        </form>
      </CardContent>
    </>
  );
}

function SetupForm({
  onSuccess,
  onBack,
}: {
  onSuccess: () => void;
  /** Present when reached via "forgot password" — offers a way back. */
  onBack?: () => void;
}) {
  const [token, setToken] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const mutation = useMutation({ mutationFn: setup, onSuccess });

  const mismatch = confirm.length > 0 && confirm !== password;
  const tooShort = password.length > 0 && password.length < 8;
  const ready =
    token.length > 0 &&
    username.trim().length > 0 &&
    password.length >= 8 &&
    confirm === password;

  return (
    <>
      <CardHeader>
        <CardTitle className="text-2xl">
          {onBack ? '重置控制台账号' : '初始化 Dormice 控制台'}
        </CardTitle>
        <CardDescription>
          {onBack
            ? '粘贴 daemon 的 API token 证明这台机器是你的,重新设置账号密码。原账号会被覆盖,所有已登录会话立即失效。'
            : '还没有账号。粘贴 daemon 的 API token 证明这台机器是你的,并设置之后日常登录用的账号密码。'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            mutation.mutate({ token, username: username.trim(), password });
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
              <FieldError>
                {errorText(mutation.error, 'API token 不对。')}
              </FieldError>
            )}
          </Field>
          <Field>
            <FieldLabel htmlFor="new-username">用户名</FieldLabel>
            <Input
              id="new-username"
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
          </Field>
          <Field data-invalid={tooShort || undefined}>
            <FieldLabel htmlFor="new-password">密码</FieldLabel>
            <Input
              id="new-password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              aria-invalid={tooShort || undefined}
            />
            {tooShort && <FieldError>密码至少 8 位。</FieldError>}
          </Field>
          <Field data-invalid={mismatch || undefined}>
            <FieldLabel htmlFor="confirm-password">确认密码</FieldLabel>
            <Input
              id="confirm-password"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
              aria-invalid={mismatch || undefined}
            />
            {mismatch && <FieldError>两次输入的密码不一致。</FieldError>}
          </Field>
          <Button
            type="submit"
            disabled={!ready || mutation.isPending}
            className="w-full"
          >
            {mutation.isPending && <Spinner />}
            {onBack ? '重置并登录' : '初始化并登录'}
          </Button>
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              className="text-xs text-muted-foreground underline-offset-4 hover:underline"
            >
              返回登录
            </button>
          )}
          <InsecureContextHint />
        </form>
      </CardContent>
    </>
  );
}
