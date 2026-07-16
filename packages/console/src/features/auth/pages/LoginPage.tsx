import { useMutation, useQuery } from '@tanstack/react-query';
import { useSearch } from '@tanstack/react-router';
import { useState } from 'react';
import Grainient from '@/components/Grainient';
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
 *
 * The shell is openasi's split card (2026-07-16, user's pick): brand panel
 * with a shader gradient on the left, the forms on the right. The panel is
 * md+ only — on a phone the form is the whole story.
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
    <main className="flex min-h-svh items-center justify-center p-6">
      <Card className="w-full max-w-4xl overflow-hidden p-0">
        {/* min-h keeps the login form roomy; the setup form is taller and
            simply stretches the card — no fixed height, no inner scroll. */}
        <div className="grid md:min-h-[32rem] md:grid-cols-2">
          {/* 左侧品牌面板：着色器渐变，小屏隐藏。三色与主题主色同为蓝紫色族。 */}
          <div className="relative hidden md:block">
            <Grainient
              color1="#FF9FFC"
              color2="#5227FF"
              color3="#B497CF"
              timeSpeed={0.25}
              colorBalance={0}
              warpStrength={1}
              warpFrequency={5}
              warpSpeed={2}
              warpAmplitude={50}
              blendAngle={0}
              blendSoftness={0.05}
              rotationAmount={500}
              noiseScale={2}
              grainAmount={0.1}
              grainScale={2}
              grainAnimated={false}
              contrast={1.5}
              gamma={1}
              saturation={1}
              centerX={0}
              centerY={0}
              zoom={0.9}
              className="absolute inset-0"
            />
            <div className="absolute inset-0 bg-gradient-to-b from-black/40 via-transparent to-black/65" />
            {/* 顶部品牌标记：wordmark 在上，产品定位在下 */}
            <div className="absolute inset-x-0 top-0 p-9">
              <p className="text-xl font-semibold tracking-tight text-white [font-family:'Google_Sans',sans-serif]">
                Dormice
              </p>
              <p className="mt-1.5 text-sm text-white/90">
                自托管 Agent 沙箱平台
              </p>
            </div>
            {/* 底部主张：大字主张 + 细横线 + 副文案 */}
            <div className="absolute inset-x-0 bottom-0 p-9">
              <h2 className="text-3xl leading-[1.2] font-semibold tracking-tight text-white [font-family:'Google_Sans',sans-serif]">
                The SQLite of
                <br />
                agent sandboxes
              </h2>
              <div className="mt-6 h-px w-12 bg-white/40" />
              <p className="mt-5 text-sm leading-relaxed text-white/75">
                单机部署，沙箱永生，空闲即免费——一台机器，就是你的沙箱舰队。
              </p>
            </div>
          </div>
          {/* 右侧表单：读取/连不上/登录/初始化四态，逻辑与改版前一致 */}
          <div className="flex flex-col justify-center gap-6 px-2 py-10">
            {status.isPending ? (
              <CardContent className="flex justify-center py-10">
                <Spinner />
              </CardContent>
            ) : status.isError ? (
              <CardContent className="py-10 text-center text-sm text-muted-foreground">
                无法连接 daemon：{status.error.message}
              </CardContent>
            ) : status.data.accountExists && !resetting ? (
              <LoginForm
                onSuccess={enter}
                onForgot={() => setResetting(true)}
              />
            ) : (
              <SetupForm
                onSuccess={enter}
                onBack={resetting ? () => setResetting(false) : undefined}
              />
            )}
          </div>
        </div>
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
        <CardTitle className="text-xl">欢迎回来</CardTitle>
        <CardDescription>登录以管理你的沙箱。</CardDescription>
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
              className="h-8.5"
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
              className="h-8.5"
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
            className="mt-4 h-8.5 w-full"
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
        <CardTitle className="text-xl">
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
              className="h-8.5 font-mono"
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
              className="h-8.5"
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
          </Field>
          <Field data-invalid={tooShort || undefined}>
            <FieldLabel htmlFor="new-password">密码</FieldLabel>
            <Input
              id="new-password"
              className="h-8.5"
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
              className="h-8.5"
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
            className="mt-4 h-8.5 w-full"
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
