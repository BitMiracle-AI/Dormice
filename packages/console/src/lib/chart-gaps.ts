/**
 * 采样断档处插一个 null 行:沙箱停着或 daemon 停机的时段没有样本,
 * 曲线要如实断开(配合 recharts 的 connectNulls={false}),不许把空窗
 * 连成一条谎线。断档的判据是点距超过期望间距的 3 倍 — 期望间距优先用
 * 服务端的桶宽,原始样本则取中位点距(采样间隔是服务端配置,客户端
 * 不猜死值)。总览堆叠图与指标 tab 的走势图共用这一条规则:断在哪里
 * 只许有一种裁决。
 *
 * `atOf` 取一行的毫秒时刻,`gapRowAt` 造一行全 null 的断点行(时刻取
 * 断档两端的中点)。行必须按时间升序进来 — 服务端本就按升序答。
 */
export function withGapBreaks<T>(
  rows: T[],
  bucketSeconds: number | null,
  atOf: (row: T) => number,
  gapRowAt: (atMs: number) => T,
): T[] {
  const first = rows[0];
  if (rows.length < 2 || first === undefined) return rows;

  const deltas: number[] = [];
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1];
    const cur = rows[i];
    if (prev !== undefined && cur !== undefined) {
      deltas.push(atOf(cur) - atOf(prev));
    }
  }
  deltas.sort((a, b) => a - b);
  const expectedMs =
    bucketSeconds !== null
      ? bucketSeconds * 1000
      : (deltas[Math.floor(deltas.length / 2)] ?? 0);

  const withGaps: T[] = [first];
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1];
    const cur = rows[i];
    if (prev === undefined || cur === undefined) continue;
    if (expectedMs > 0 && atOf(cur) - atOf(prev) > 3 * expectedMs) {
      withGaps.push(gapRowAt(Math.round((atOf(prev) + atOf(cur)) / 2)));
    }
    withGaps.push(cur);
  }
  return withGaps;
}
