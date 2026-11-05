/**
 * 发送兜底：正文缺表情标记时，向 qq-stickers 的掷骰单例要一张图。
 *
 * 通过同进程动态 import 兄弟扩展的 gate.ts（Node ESM 按 URL 缓存模块，同一文件
 * 全进程只有一个实例），兜底掷骰与 qq_sticker_pick 工具共享同一份概率、保底、
 * 冷却与防重复状态——出图频率仍由表情扩展唯一仲裁。
 *
 * 兄弟扩展不存在（独立发布、目录改名）时按未启用处理，静默降级为纯文本发送。
 */
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export interface AutoPickModule {
  autoPick(opts?: { force?: boolean; mood?: string; avoid?: string[]; emojiDir?: string }): {
    pass: boolean;
    reason?: string;
    rel?: string;
    category?: string;
    character?: string;
  };
}

let gatePromise: Promise<AutoPickModule | null> | null = null;

/** 从本模块位置推导兄弟扩展的 gate.ts；解析失败返回 null。 */
function gateModuleUrl(): string | null {
  try {
    // 本文件位于 <local>/cortico-world-qq-initiative/src/outbound/，上跳三级即扩展根的上级
    const here = fileURLToPath(new URL('.', import.meta.url));
    const gatePath = resolve(here, '..', '..', '..', 'cortico-world-qq-stickers', 'src', 'gate.ts');
    return pathToFileURL(gatePath).href;
  } catch {
    return null;
  }
}

/** 加载掷骰单例；任何失败都归一为 null（兜底禁用），只尝试一次。 */
export function loadStickerGate(): Promise<AutoPickModule | null> {
  if (!gatePromise) {
    const url = gateModuleUrl();
    gatePromise = url
      ? import(url).then((m) => m as AutoPickModule).catch(() => null)
      : Promise.resolve(null);
  }
  return gatePromise;
}

/** 测试用：清掉缓存的加载结果。 */
export function resetStickerGateCache(): void {
  gatePromise = null;
}

/** 正文里是否已带表情/图片标记（兜底只补全裸文本）。 */
export function hasStickerMarker(text: string): boolean {
  return /\[(?:表情包|图片)\s*[:：]/.test(text);
}

/**
 * 兜底掷骰：通过则返回可直接拼接的 [表情包:路径] 标记，未通过返回 null。
 * emojiDir 兜底传给 gate，仅在表情扩展自己未配置时使用。
 */
export async function fallbackStickerMarker(emojiDir: string, log?: { info(m: string): void }): Promise<string | null> {
  const gate = await loadStickerGate();
  if (!gate) return null;
  const result = gate.autoPick({ emojiDir });
  if (!result.pass || !result.rel) {
    if (log && result.reason) log.info(`[发信] 表情兜底未通过：${result.reason}`);
    return null;
  }
  return `[表情包:${result.rel}]`;
}
