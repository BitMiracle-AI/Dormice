/**
 * 扩展名 → 预览形态的唯一裁决点(组件禁止各自 endsWith 判断)。服务端
 * MIME 表(server/e2b/envd/files.ts 的 MIME_BY_EXTENSION)是参照不是
 * import — 那张表管 wire 的 content-type,这里管 UI 的渲染策略,变更
 * 节奏不同。
 *
 * - image/pdf:header 认证下载成 Blob,object URL 就地渲染 — 同源、
 *   明文 HTTP 的 IP 访问也能用。svg 永远走 <img>(规范保证不执行脚本、
 *   不发子请求;换成 iframe/object 就是给沙箱里的文件开脚本执行口)。
 * - office:浏览器铸签名直链交给 Microsoft 在线查看器抓取渲染 — 旧版
 *   doc/xls/ppt 一并收,查看器原生支持,砍掉反而要写"为什么不"。
 * - 视频/音频刻意不收:服务端不支持 Range 请求,播放器拖不了进度条 —
 *   残疾预览不如诚实只给下载;将来加了 Range 再回头。
 */
export type PreviewKind = 'image' | 'pdf' | 'office' | 'other';

const KIND_BY_EXTENSION: Record<string, PreviewKind> = {
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  svg: 'image',
  webp: 'image',
  ico: 'image',
  pdf: 'pdf',
  doc: 'office',
  docx: 'office',
  xls: 'office',
  xlsx: 'office',
  ppt: 'office',
  pptx: 'office',
};

export function previewKindOf(name: string): PreviewKind {
  // 与服务端 contentTypeOf 同规则:最后一个 '.' 之后、点开头的隐藏文件
  // (.env)不算有扩展名、大小写不敏感。
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  return KIND_BY_EXTENSION[ext] ?? 'other';
}
