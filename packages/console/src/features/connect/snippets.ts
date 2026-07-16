/**
 * 接入示例的单一来源:连接页与总览页的快速接入卡共用这里的模板,
 * 不各自手写第二份。endpoint 永远是当前页面 origin — daemon 自己
 * 托管控制台,浏览器怎么到的,SDK 就怎么到。
 */

export const e2bSnippet = (origin: string) => `import { Sandbox } from 'e2b';

const sandbox = await Sandbox.create({
  apiKey: 'e2b_<your API token>',
  apiUrl: '${origin}/e2b/api',
  sandboxUrl: '${origin}/e2b/envd',
  // Dormice 扩展:同一个 name 永远回到同一个沙箱。
  metadata: { name: 'my-project' },
});

const result = await sandbox.commands.run('echo hello from dormice');`;

/** 总览页快速接入卡的精简版:两个 URL 一个前缀,一眼看完。 */
export const e2bQuickSnippet = (
  origin: string,
) => `import { Sandbox } from 'e2b';

const sandbox = await Sandbox.create({
  apiKey: 'e2b_<your API token>',
  apiUrl: '${origin}/e2b/api',
  sandboxUrl: '${origin}/e2b/envd',
});`;

export const sdkSnippet = (
  origin: string,
) => `import { Dormice } from '@dormice/sdk';

const client = new Dormice({
  endpoint: '${origin}',
  token: '<your API token>',
});

await client.acquireSandbox('my-project');
const result = await client.execCommand('my-project', 'echo hello');`;

export const cliSnippet = (origin: string) => `export DORMICE_ENDPOINT=${origin}
export DORMICE_API_TOKEN=<your API token>

dor sandbox ls
dor sandbox exec my-project 'uname -r'`;
