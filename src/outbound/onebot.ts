/**
 * OneBot v11 HTTP 客户端
 * 只依赖 Node 内置能力（fetch / URL / AbortSignal），发信结果以平台回执为准；
 * 所有网络与协议异常都收敛成失败回执，绝不向上抛出。
 */
import type { SendReceipt } from '../types.ts';

/** OneBot 发送段（只覆盖本扩展用到的两种；与 qq-stickers/src/resolve.ts 同形）。 */
export type OutgoingSegment =
  | { type: 'text'; data: { text: string } }
  | { type: 'image'; data: { file: string } };

export interface OneBotEndpoint {
  baseUrl: string;
  accessToken?: string;
  timeoutMs?: number;
}

export interface OneBotPingResult {
  ok: boolean;
  userId?: string;
  nickname?: string;
  error?: string;
}

interface OneBotEnvelope {
  status?: unknown;
  retcode?: unknown;
  data?: unknown;
  message?: unknown;
  wording?: unknown;
}

interface OneBotRawResult {
  ok: boolean;
  data?: unknown;
  raw?: unknown;
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 8000;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 60000;

/**
 * 规范化服务地址：缺协议时补 http://，去掉末尾斜杠，去空白。
 */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!trimmed) return '';
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  return withScheme.replace(/\/+$/, '');
}

/** 从 private:123 / group:456 / 纯数字中提取纯数字标识 */
function toNumericId(raw: string): string | null {
  const digits = String(raw ?? '').replace(/\D/g, '');
  return digits || null;
}

/**
 * 脱敏：错误文案里可能带上带 query 的 URL 或令牌，写日志前先剥掉，避免凭据进日志（方案 9.6.4）。
 */
export function sanitizeText(raw: unknown): string {
  return String(raw ?? '')
    .replace(/access_token=[^&\s"'）)]*/gi, 'access_token=***')
    .replace(/(https?:\/\/[^\s?'"）)]+)\?[^\s'"）)]*/gi, '$1')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer ***');
}

function describeError(err: unknown, timeoutMs: number): string {
  if (err instanceof Error) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return `OneBot 请求超时（${timeoutMs}ms）`;
    }
    const cause = (err as { cause?: unknown }).cause;
    if (cause instanceof Error && cause.message) {
      return `OneBot 请求失败：${sanitizeText(err.message)}（${sanitizeText(cause.message)}）`;
    }
    return `OneBot 请求失败：${sanitizeText(err.message)}`;
  }
  return `OneBot 请求失败：${sanitizeText(err)}`;
}

export class OneBotHttpClient {
  private readonly baseUrl: string;
  private readonly accessToken: string;
  private readonly timeoutMs: number;

  constructor(ep: OneBotEndpoint) {
    this.baseUrl = normalizeBaseUrl(ep?.baseUrl ?? '');
    this.accessToken = typeof ep?.accessToken === 'string' ? ep.accessToken.trim() : '';
    const timeout = Number(ep?.timeoutMs);
    this.timeoutMs =
      Number.isFinite(timeout) && timeout >= MIN_TIMEOUT_MS
        ? Math.min(Math.floor(timeout), MAX_TIMEOUT_MS)
        : DEFAULT_TIMEOUT_MS;
  }

  /** 当前使用的服务地址，便于日志与状态查询 */
  get endpoint(): string {
    return this.baseUrl;
  }

  /**
   * 探测通道可用性并读取登录账号
   */
  async ping(): Promise<OneBotPingResult> {
    if (!this.baseUrl) {
      return { ok: false, error: '未配置 OneBot HTTP 服务地址' };
    }
    const res = await this.request('get_login_info', 'GET');
    if (!res.ok) {
      return { ok: false, error: res.error ?? 'OneBot 登录信息获取失败' };
    }
    const data = (res.data ?? {}) as Record<string, unknown>;
    const rawId = data.user_id;
    const nickname = typeof data.nickname === 'string' ? data.nickname : undefined;
    return {
      ok: true,
      userId: rawId === undefined || rawId === null ? undefined : String(rawId),
      nickname,
    };
  }

  async sendPrivate(userId: string, text: string, segments?: OutgoingSegment[]): Promise<SendReceipt> {
    return this.sendMessage('send_private_msg', 'user_id', 'private', userId, text, segments);
  }

  async sendGroup(groupId: string, text: string, segments?: OutgoingSegment[]): Promise<SendReceipt> {
    return this.sendMessage('send_group_msg', 'group_id', 'group', groupId, text, segments);
  }

  /**
   * 发送一条消息。带图片段时拆成多条发送：先发纯文字一条，再在结尾逐张单独发图，
   * 对齐 qq-final 日常对话的分段形态——文字和图不挤在同一个气泡里。
   * 文字条失败直接按失败返回；图片条失败不整体报错（文字已送达，报失败会诱发重复发送），
   * 失败明细附在回执 raw.imageFailures 里。
   */
  private async sendMessage(
    action: string,
    idField: string,
    kind: 'private' | 'group',
    rawId: string,
    text: string,
    segments?: OutgoingSegment[],
  ): Promise<SendReceipt> {
    const id = toNumericId(rawId);
    const body = typeof text === 'string' ? text : String(text ?? '');
    const address = id ? `${kind}:${id}` : `${kind}:${String(rawId ?? '')}`;

    if (!id) {
      return {
        ok: false,
        address,
        text: body,
        error: `${kind === 'group' ? '群号' : 'QQ 号'}无效：${String(rawId ?? '')}`,
      };
    }
    if (!body.trim() && segments?.length === 0) {
      return { ok: false, address, text: body, error: '消息正文为空' };
    }
    if (!this.baseUrl) {
      return { ok: false, address, text: body, error: '未配置 OneBot HTTP 服务地址' };
    }

    // 段数组里没有图片：维持原路径，单条发出（段数组或纯文本）
    const hasImage = segments?.some((s) => s.type === 'image') ?? false;
    if (!hasImage) {
      const message = segments && segments.length > 0 ? segments : body;
      const res = await this.request(action, 'POST', {
        [idField]: Number(id),
        message,
      });
      if (!res.ok) {
        return { ok: false, address, text: body, error: res.error ?? 'OneBot 发送失败', raw: res.raw };
      }
      const data = (res.data ?? {}) as Record<string, unknown>;
      const rawMessageId = data.message_id;
      if (rawMessageId === undefined || rawMessageId === null) {
        return { ok: false, address, text: body, error: 'OneBot 未返回 message_id', raw: res.raw };
      }
      return { ok: true, address, text: body, messageId: rawMessageId as string | number, raw: res.raw };
    }

    // 分段发送：文字一条 + 图片逐张一条
    const textParts = segments!
      .filter((s): s is { type: 'text'; data: { text: string } } => s.type === 'text')
      .map((s) => s.data.text.trim())
      .filter(Boolean);
    const images = segments!.filter((s): s is { type: 'image'; data: { file: string } } => s.type === 'image');

    const send = async (message: string | OutgoingSegment[]): Promise<OneBotRawResult> =>
      this.request(action, 'POST', { [idField]: Number(id), message });

    let messageId: string | number | undefined;
    const imageFailures: string[] = [];

    if (textParts.length > 0) {
      const textRes = await send(textParts.join('\n'));
      if (!textRes.ok) {
        return { ok: false, address, text: body, error: textRes.error ?? 'OneBot 发送失败', raw: textRes.raw };
      }
      const data = (textRes.data ?? {}) as Record<string, unknown>;
      if (data.message_id !== undefined && data.message_id !== null) {
        messageId = data.message_id as string | number;
      } else if (!images.length) {
        return { ok: false, address, text: body, error: 'OneBot 未返回 message_id', raw: textRes.raw };
      }
    }

    for (const image of images) {
      const imgRes = await send([image]);
      if (!imgRes.ok) {
        imageFailures.push(imgRes.error ?? 'OneBot 发送失败');
        continue;
      }
      const data = (imgRes.data ?? {}) as Record<string, unknown>;
      // 纯图消息（正文为空）时以图片条的 message_id 为准
      if (!textParts.length && data.message_id !== undefined && data.message_id !== null) {
        messageId = data.message_id as string | number;
      }
    }

    // 只有文字时 messageId 必已拿到（上方已校验）；纯图时最后一张的 id 在手
    if (messageId === undefined) {
      return { ok: false, address, text: body, error: 'OneBot 未返回 message_id' };
    }
    return {
      ok: true,
      address,
      text: body,
      messageId,
      raw: imageFailures.length > 0 ? { imageFailures } : undefined,
    };
  }

  private buildUrl(action: string): string {
    const url = new URL(`${this.baseUrl}/${action}`);
    if (this.accessToken) url.searchParams.set('access_token', this.accessToken);
    return url.toString();
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.accessToken) headers.authorization = `Bearer ${this.accessToken}`;
    return headers;
  }

  private async request(
    action: string,
    method: 'GET' | 'POST',
    payload?: Record<string, unknown>,
  ): Promise<OneBotRawResult> {
    const url = this.buildUrl(action);
    try {
      const response = await fetch(url, {
        method,
        headers: this.buildHeaders(),
        body: method === 'POST' ? JSON.stringify(payload ?? {}) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      const rawText = await response.text();
      let parsed: OneBotEnvelope | null = null;
      try {
        parsed = rawText ? (JSON.parse(rawText) as OneBotEnvelope) : null;
      } catch {
        parsed = null;
      }

      if (!response.ok) {
        const detail = rawText ? `：${sanitizeText(rawText.slice(0, 200))}` : '';
        return { ok: false, error: `OneBot HTTP ${response.status}${detail}`, raw: parsed ?? sanitizeText(rawText.slice(0, 200)) };
      }
      if (!parsed || typeof parsed !== 'object') {
        const detail = rawText ? `：${sanitizeText(rawText.slice(0, 200))}` : '';
        return { ok: false, error: `OneBot 响应不是合法 JSON${detail}`, raw: sanitizeText(rawText.slice(0, 200)) };
      }

      const retcode = Number(parsed.retcode);
      if (!Number.isFinite(retcode) || retcode !== 0) {
        const reason = String(parsed.wording ?? parsed.message ?? '').trim();
        const retcodeText = parsed.retcode === undefined || parsed.retcode === null ? 'unknown' : String(parsed.retcode);
        return {
          ok: false,
          error: reason ? `OneBot 返回失败：retcode=${retcodeText} ${reason}` : `OneBot 返回失败：retcode=${retcodeText}`,
          raw: parsed,
        };
      }

      return { ok: true, data: parsed.data, raw: parsed };
    } catch (err) {
      return { ok: false, error: describeError(err, this.timeoutMs) };
    }
  }
}
