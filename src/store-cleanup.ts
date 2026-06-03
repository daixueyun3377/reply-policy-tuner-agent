import { readdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";

/**
 * 概率性清理目录中过期的 JSON 文件。
 *
 * 支持两种模式：
 * - relative：文件中 timestampField 是创建时间，超过 maxAgeMs 则过期
 * - absolute：文件中 timestampField 是绝对过期时间，nowMs > 该值即过期
 *
 * 以 1/N 概率触发（默认每 5 次写入触发一次），避免每次写入都扫目录。
 */
export async function pruneExpiredFiles(options: {
  readonly dir: string;
  /** JSON 文件中存储时间戳的字段名 */
  readonly timestampField: string;
  /** 超过此时间（毫秒）的文件将被删除（relative 模式用） */
  readonly maxAgeMs: number;
  /** true 表示 timestampField 是绝对过期时间；false/省略表示是创建时间 + maxAgeMs 计算过期 */
  readonly absoluteExpiry?: boolean;
  /** 触发概率的分母（默认 5，即 1/5 概率触发） */
  readonly probabilityDenominator?: number;
  readonly nowMs?: number;
  /** 排除的文件路径列表（绝对路径），这些文件不会被清理 */
  readonly excludeFiles?: readonly string[];
}): Promise<void> {
  const denominator = options.probabilityDenominator ?? 5;
  if (Math.random() * denominator >= 1) {
    return;
  }

  const nowMs = options.nowMs ?? Date.now();
  const excludeSet = new Set(options.excludeFiles ?? []);

  let entries: string[];
  try {
    entries = await readdir(options.dir);
  } catch {
    return;
  }

  const jsonFiles = entries.filter((name) => name.endsWith(".json"));

  await Promise.all(
    jsonFiles.map(async (name) => {
      const filePath = join(options.dir, name);

      if (excludeSet.has(filePath)) {
        return;
      }

      try {
        const raw = await readFile(filePath, "utf8");
        const data = JSON.parse(raw.trim()) as Record<string, unknown>;
        const timestamp = data[options.timestampField];
        if (typeof timestamp !== "number") {
          // 无法判断过期，跳过
          return;
        }

        const expired = options.absoluteExpiry === true
          ? nowMs >= timestamp
          : nowMs - timestamp > options.maxAgeMs;

        if (expired) {
          await unlink(filePath);
        }
      } catch {
        // 文件读取/解析失败：可能是并发删除或损坏，尝试清理
        try {
          await unlink(filePath);
        } catch {
          // ignore
        }
      }
    }),
  );
}
