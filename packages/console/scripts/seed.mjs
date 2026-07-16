#!/usr/bin/env node
/**
 * 给本地开发的 daemon 填一份生动的演示数据:3 个模板、8 个策略各异的
 * 沙箱、若干文件 — 让 console 一打开就有东西可看、可点。裸 fetch 打
 * 原生 RPC,零依赖;沙箱状态的多样性(冻结/停止)靠 daemon 的空闲扫描
 * 器降温,所以 dev daemon 要把扫描间隔拧到 1 秒(见下)。
 *
 * 用法(fake 执行器即可,勿对生产 daemon 跑;token 要求 ≥32 字符;
 * server 包刻意没有 dev 脚本 — daemon 跑的永远是构建产物):
 *   0) export DORMICE_API_TOKEN=$(openssl rand -hex 32)
 *   1) pnpm --filter @dormice/server... --filter @dormice/console... build
 *   2) DORMICE_SCAN_INTERVAL_SECONDS=1 node packages/server/dist/main.js
 *   3) pnpm --filter @dormice/console seed
 *   4) 直接看:daemon 自己托管 http://127.0.0.1:3676/console(登录 token 即上面那个);
 *      要改前端代码带热更新,才需要 pnpm --filter @dormice/console dev → http://localhost:5173/console
 *
 * 注:模板指向的镜像名在 fake 模式下随意;对 docker 执行器跑时镜像必须
 * 真的在宿主机上,否则用这些模板创建会得到点名的报错(那也是诚实)。
 */

const endpoint = process.env.DORMICE_ENDPOINT ?? 'http://127.0.0.1:3676';
const token = process.env.DORMICE_API_TOKEN;
if (!token) {
  console.error('缺 DORMICE_API_TOKEN — 与 dev daemon 用同一个值');
  process.exit(1);
}

async function rpc(path, body = {}) {
  const res = await fetch(`${endpoint}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(`${path} → ${res.status}:${detail.message ?? '(无信息)'}`);
  }
  return res.json();
}

const write = (name, files) =>
  rpc('/writeFiles', {
    name,
    files: files.map(([path, text]) => ({
      path,
      contentBase64: Buffer.from(text, 'utf8').toString('base64'),
    })),
  });

// ---- 模板 -------------------------------------------------------------
const templates = [
  ['python-ml', 'python-ml:v2'],
  ['node-agent', 'node-agent:v1'],
  ['claude-code', 'dormice-base:20260710b'],
];
for (const [name, image] of templates) {
  await rpc('/registerTemplate', { name, image });
  console.log(`模板  ${name} → ${image}`);
}

// ---- 沙箱 -------------------------------------------------------------
// freeze/stop 阈值都是秒级,好让 1 秒间隔的扫描器几秒内演完降温;
// stopAfterSeconds: null 是常驻 agent 档,永远停在 frozen。
const sandboxes = [
  {
    name: 'demo-agent',
    policy: { freezeAfterSeconds: 300, stopAfterSeconds: null },
    template: 'claude-code',
    metadata: { app: 'assistant', env: 'prod' },
  },
  {
    name: 'web-scraper',
    policy: { freezeAfterSeconds: 5 },
    template: 'python-ml',
    metadata: { app: 'crawler', env: 'prod' },
  },
  {
    name: 'build-runner',
    policy: { freezeAfterSeconds: 3, stopAfterSeconds: 8 },
    metadata: { app: 'ci' },
  },
  {
    name: 'docs-writer',
    policy: { freezeAfterSeconds: 5 },
    template: 'node-agent',
    metadata: { app: 'assistant', env: 'staging' },
  },
  {
    name: 'email-triage',
    policy: { freezeAfterSeconds: 600, stopAfterSeconds: null },
    metadata: { app: 'assistant', env: 'prod' },
  },
  {
    name: 'ci-check',
    policy: { freezeAfterSeconds: 4, stopAfterSeconds: 10 },
    metadata: { app: 'ci' },
  },
  {
    name: 'data-pipeline',
    policy: { freezeAfterSeconds: 900 },
    template: 'python-ml',
    metadata: { app: 'crawler', env: 'staging' },
  },
  // 刻意不带标签:列表的标签列该有留白的样子,筛选也筛得掉它。
  { name: 'scratch' },
];
for (const { name, policy, template, metadata } of sandboxes) {
  await rpc('/acquireSandbox', {
    name,
    ...(policy ? { policy } : {}),
    ...(template ? { template } : {}),
    ...(metadata ? { metadata } : {}),
  });
  console.log(`沙箱  ${name}`);
}

// ---- 文件(给文件浏览器一些可看的内容)---------------------------------
await write('demo-agent', [
  [
    'README.md',
    '# demo-agent\n\n常驻 agent 的工作目录 — 冻结时住在 swap 里,唤醒约 50ms。\n',
  ],
  ['main.py', 'import json\n\nprint(json.dumps({"answer": 42}))\n'],
  ['data/notes.txt', '盘是本体:容器随便换,/home/user 一直在。\n'],
]);
await write('docs-writer', [
  ['drafts/quickstart.md', '# Quickstart\n\nacquire → exec → release。\n'],
]);
console.log('文件  demo-agent(3 个)、docs-writer(1 个)');

// ---- 等扫描器把状态演出来 -----------------------------------------------
console.log('\n等扫描器降温(最多 20 秒)…');
const deadline = Date.now() + 20_000;
let last = '';
while (Date.now() < deadline) {
  const { sandboxes: rows } = await rpc('/listSandboxes');
  const counts = {};
  for (const row of rows) counts[row.state] = (counts[row.state] ?? 0) + 1;
  last = Object.entries(counts)
    .map(([state, n]) => `${state} ${n}`)
    .join(' · ');
  if ((counts.frozen ?? 0) >= 2 && (counts.stopped ?? 0) >= 2) break;
  await new Promise((resolve) => setTimeout(resolve, 2000));
}
console.log(`状态  ${last}`);
if (!last.includes('frozen')) {
  console.log(
    '(全都还是 active?dev daemon 大概没开 DORMICE_SCAN_INTERVAL_SECONDS=1,' +
      '等它的下一轮扫描即可)',
  );
}
console.log('\n完成。打开 console 看看吧。');
