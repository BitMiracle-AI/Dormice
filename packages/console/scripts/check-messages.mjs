/**
 * 消息文件守门人:每个 locale 对 baseLocale(zh-CN,权威源)逐 key 比对。
 *
 * 为什么需要它:Paraglide 编译**不校验**各语言 key 集是否一致,缺 key
 * 与多 key 都能编译通过,代价推到运行时——实测缺 key 时渲染出的是
 * **原始 key 名**(不是回落到中文),多余 key 则让 baseLocale 渲染出
 * key 名。这两种坏结果在 UI 上都不会报错,只会难看,所以只能靠机械
 * 比对在 CI 里拦。
 *
 * 查五件事:key 集合与顺序、{占位符} 集合、省略号(文案纪律)、漏译
 * 探针(非 CJK 语言里出现汉字/假名/谚文=没翻或串了语言)、JSON 合法。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const project = JSON.parse(
  readFileSync(join(ROOT, 'project.inlang/settings.json'), 'utf8'),
);
const { baseLocale, locales } = project;
// pathPattern 就是域文件清单(单一真相源),从中反解出域名。
const domains = project['plugin.inlang.messageFormat'].pathPattern.map((p) =>
  p.replace(/^.*\/([^/]+)\.json$/, '$1'),
);

const paramsOf = (s) =>
  [...String(s).matchAll(/\{(\w+)\}/g)]
    .map((mm) => mm[1])
    .sort()
    .join(',');

// 每个 locale 的译文里不该出现的字符类。CJK 三族互不为邻:日文可以有
// 汉字、韩文现代文本不用汉字、拉丁/西里尔语言一个都不该有。
const HAN = '\\u4e00-\\u9fff';
const KANA = '\\u3040-\\u30ff';
const HANGUL = '\\uac00-\\ud7af';
const CJK_ANY = new RegExp(`[${HAN}${KANA}${HANGUL}]`);
const STRAY = {
  'zh-TW': new RegExp(`[${KANA}${HANGUL}]`),
  ja: new RegExp(`[${HANGUL}]`),
  ko: new RegExp(`[${HAN}${KANA}]`),
  de: CJK_ANY,
  es: CJK_ANY,
  fr: CJK_ANY,
  'pt-BR': CJK_ANY,
  ru: CJK_ANY,
};

const read = (locale, domain) =>
  JSON.parse(
    readFileSync(join(ROOT, 'messages', locale, `${domain}.json`), 'utf8'),
  );

let bad = 0;
const fail = (msg) => {
  console.error(`✗ ${msg}`);
  bad += 1;
};

for (const locale of locales) {
  if (locale === baseLocale) continue;
  let checked = 0;
  for (const domain of domains) {
    const base = read(baseLocale, domain);
    let tr;
    try {
      tr = read(locale, domain);
    } catch (err) {
      fail(`${locale}/${domain}.json 读不出来:${err.message}`);
      continue;
    }
    const bk = Object.keys(base);
    const tk = Object.keys(tr);
    if (bk.join('\n') !== tk.join('\n')) {
      const miss = bk.filter((k) => !tk.includes(k));
      const extra = tk.filter((k) => !bk.includes(k));
      const detail =
        miss.length || extra.length
          ? `缺 [${miss.join(' ')}] 多 [${extra.join(' ')}]`
          : 'key 顺序与源不一致';
      fail(`${locale}/${domain}.json ${detail}`);
    }
    for (const key of bk) {
      if (key === '$schema' || !(key in tr)) continue;
      checked += 1;
      if (paramsOf(base[key]) !== paramsOf(tr[key])) {
        fail(
          `${locale}/${domain}.json:${key} 占位符不符 [${paramsOf(base[key])}] → [${paramsOf(tr[key])}]`,
        );
      }
      if (/…|\.\.\./.test(tr[key]) && !/…|\.\.\./.test(base[key])) {
        fail(`${locale}/${domain}.json:${key} 引入省略号(文案纪律):${tr[key]}`);
      }
      if (STRAY[locale]?.test(tr[key])) {
        fail(`${locale}/${domain}.json:${key} 疑似漏译:${tr[key]}`);
      }
    }
  }
  console.log(`${locale.padEnd(6)} ${checked} 条比对完`);
}

if (bad > 0) {
  console.error(`\n${bad} 处问题 — 消息文件未对齐`);
  process.exit(1);
}
console.log(`\n${locales.length} 个 locale 全部与 ${baseLocale} 对齐`);
