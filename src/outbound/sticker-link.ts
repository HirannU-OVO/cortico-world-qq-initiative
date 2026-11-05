/**
 * 出站表情解析的跨包加载：真正的逻辑住在兄弟扩展 qq-stickers 的 resolve.ts
 * （谁有表情库、谁管掷骰，谁就拥有「表情怎么进消息」），本扩展只是调用方。
 *
 * 通过同进程动态 import 兄弟扩展的模块（Node ESM 按 URL 缓存，同一文件全进程
 * 一个实例），与表情扩展共享同一份概率/保底/冷却/防连发账本。
 *
 * 兄弟扩展不存在（独立发布、目录改名）或加载失败时按未启用处理，静默降级为纯文本。
 * 「表情管理关了就不发图」由 resolve.ts 内部的 ownerActive 把守，这里不重复判断。
 */
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

/** 与 qq-stickers/src/resolve.ts 的导出同形（结构化类型，不跨包 import 类型）。 */
export interface StickerResolveModule {
  hasStickerMarker(text: string): boolean;
  buildOutgoingSegments(text: string): Array<
    | { type: 'text'; data: { text: string } }
    | { type: 'image'; data: { file: string } }
  >;
  resolveOutgoing(
    text: string,
    log?: { info(msg: string, fields?: Record<string, unknown>): void },
  ): {
    text: string;
    segments: Array<{ type: 'text'; data: { text: string } } | { type: 'image'; data: { file: string } }>;
  };
}

let resolvePromise: Promise<StickerResolveModule | null> | null = null;

/** 从本模块位置推导兄弟扩展的 resolve.ts；解析失败返回 null。 */
function resolveModuleUrl(): string | null {
  try {
    // 本文件位于 <local>/cortico-world-qq-initiative/src/outbound/，上跳三级即扩展根的上级
    const here = fileURLToPath(new URL('.', import.meta.url));
    const target = resolve(here, '..', '..', '..', 'cortico-world-qq-stickers', 'src', 'resolve.ts');
    return pathToFileURL(target).href;
  } catch {
    return null;
  }
}

/** 加载出站表情解析模块；任何失败都归一为 null（纯文本发送），只尝试一次。 */
export function loadStickerResolve(): Promise<StickerResolveModule | null> {
  if (!resolvePromise) {
    const url = resolveModuleUrl();
    resolvePromise = url
      ? import(url).then((m) => m as StickerResolveModule).catch(() => null)
      : Promise.resolve(null);
  }
  return resolvePromise;
}

/** 测试用：清掉缓存的加载结果。 */
export function resetStickerResolveCache(): void {
  resolvePromise = null;
}
