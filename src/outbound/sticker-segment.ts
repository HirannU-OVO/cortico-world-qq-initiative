/**
 * 把正文里的 [表情包:路径] 标记转成 OneBot 的图片段，
 * 让主动搭话也能发出真正的表情包图片，而不只是把标记当纯文本发出去。
 *
 * 做法对齐 qq-final 的 normalize.ts:buildOutgoing —— 用「段数组」而不是 CQ 码字符串：
 * 段数组不受路径里的逗号、空格、中文影响，CQ 码会。
 *
 * 路径安全：只允许解析 emojiDir 内的文件，任何越界成分（..\..\）一律拒绝，
 * 避免把本机任意文件当作图片发送出去。
 */
import { existsSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';

/** OneBot 发送段（只覆盖本扩展用到的两种）。 */
export type OutgoingSegment =
  | { type: 'text'; data: { text: string } }
  | { type: 'image'; data: { file: string } };

const IMAGE_EXTENSIONS = ['.gif', '.png', '.jpg', '.jpeg', '.webp'];

/** 在 base 目录内解析表情包文件名；找不到或越界则返回 null。 */
function resolveSticker(base: string, name: string): string | null {
  if (!base || !name) return null;
  const cleaned = name.trim().replace(/^[\\/]+/, '');
  if (!cleaned || cleaned.includes('..')) return null;

  const root = resolve(base);
  const candidates = extname(cleaned) ? [cleaned] : IMAGE_EXTENSIONS.map((ext) => cleaned + ext);
  for (const rel of candidates) {
    const abs = resolve(root, rel);
    // 必须仍在根目录内
    if (abs !== root && !abs.startsWith(root + sep)) continue;
    if (existsSync(abs)) return abs;
  }
  return null;
}

/**
 * 把正文转成 OneBot 发送段。
 * - `[表情包:分类/文件名]` → 图片段（path 模式，与 qq-final 默认一致，避免 base64 撑大请求体）
 * - 解析不到文件时丢弃该标记，不把 `[表情包:xxx]` 原样发出去
 * - emojiDir 为空时正文原样返回（纯文本段）
 */
export function buildOutgoingSegments(text: string, emojiDir: string): OutgoingSegment[] {
  const body = typeof text === 'string' ? text : String(text ?? '');
  if (!emojiDir || !body.includes('[表情包:')) {
    return body ? [{ type: 'text', data: { text: body } }] : [];
  }

  const segments: OutgoingSegment[] = [];
  const pattern = /\[表情包:([^\[\]]{1,120})\]/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(body)) !== null) {
    if (m.index > last) {
      segments.push({ type: 'text', data: { text: body.slice(last, m.index) } });
    }
    const file = resolveSticker(emojiDir, m[1]);
    if (file) segments.push({ type: 'image', data: { file } });
    last = m.index + m[0].length;
  }
  if (last < body.length) {
    segments.push({ type: 'text', data: { text: body.slice(last) } });
  }
  return segments;
}
