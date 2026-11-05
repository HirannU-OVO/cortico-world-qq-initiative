/**
 * 双模式发信器
 * builtin：走自建 OneBot HTTP 通道真实发信，回执来自平台；
 * external：由其他 World 的发信工具发送，本扩展无法观测结果，按不可观测失败处理（宁可漏记不可虚记）。
 */
import type { ProactiveConfig } from '../config.ts';
import type { SendReceipt } from '../types.ts';
import { normalizeAddress } from './adapter.ts';
import { OneBotHttpClient, sanitizeText } from './onebot.ts';
import { loadStickerResolve } from './sticker-link.ts';

/** external 模式的固定失败原因，世界回合据此回滚质押 */
export const EXTERNAL_UNOBSERVABLE_ERROR = 'external_mode_unobservable';

/** builtin 模式下本扩展注册的发信工具名 */
export const BUILTIN_SEND_TOOL = 'qq_initiative_send';

/** external 模式下建议对接的上游发信工具名 */
export const EXTERNAL_SEND_TOOL = 'qq_send';

/** 令牌环境变量名：配置项留空时从这里读取 */
export const ONEBOT_TOKEN_ENV = 'QQ_PROACTIVE_ONEBOT_TOKEN';

const DEFAULT_HTTP_URL = 'http://127.0.0.1:3000';
const DEFAULT_TIMEOUT_MS = 8000;

export interface SenderLogger {
  info(m: string): void;
  warn(m: string): void;
  error(m: string): void;
}

export interface SenderDeps {
  getConfig(): ProactiveConfig;
  log: SenderLogger;
}

export interface SenderPingResult {
  ok: boolean;
  userId?: string;
  nickname?: string;
  error?: string;
}

export class OutboundSender {
  private readonly deps: SenderDeps;
  private client: OneBotHttpClient | null = null;
  private clientKey = '';

  constructor(deps: SenderDeps) {
    this.deps = deps;
  }

  /** 当前生效的发信通道；未知取值一律按 builtin 处理 */
  get mode(): 'builtin' | 'external' | 'bridge' {
    const mode = this.deps.getConfig().outboundMode;
    if (mode === 'external') return 'external';
    if (mode === 'bridge') return 'bridge';
    return 'builtin';
  }

  /** 配置项优先，留空时读环境变量 */
  resolveToken(cfg: ProactiveConfig): string {
    const configured = typeof cfg.outboundHttpToken === 'string' ? cfg.outboundHttpToken.trim() : '';
    if (configured) return configured;
    const fromEnv = process.env[ONEBOT_TOKEN_ENV];
    return typeof fromEnv === 'string' ? fromEnv.trim() : '';
  }

  /**
   * 探测发信通道状态；external 模式不可观测，直接报告失败
   */
  async ping(): Promise<SenderPingResult> {
    const cfg = this.deps.getConfig();
    if (cfg.outboundMode === 'external') {
      return { ok: false, error: EXTERNAL_UNOBSERVABLE_ERROR };
    }
    // 桥接模式：QQ 收发由 AstrBot 侧的桥接管，本扩展不碰 OneBot 通道，
    // 可用性取决于桌宠侧桥 World 与桥的连接，不在这里探测。
    if (cfg.outboundMode === 'bridge') {
      return { ok: true };
    }
    try {
      return await this.getClient(cfg).ping();
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.deps.log.error(`[发信] 连不上 QQ 框架：${sanitizeText(reason)}。请确认框架已启动，且地址端口填对了。`);
      return { ok: false, error: reason };
    }
  }

  /**
   * 发送一条消息。
   * 地址必须是 private:<QQ号> / group:<群号>（也接受纯数字与 qq: 命名空间前缀）；
   * 任何失败都以 ok:false 返回，绝不抛出。
   */
  async send(address: string, text: string): Promise<SendReceipt> {
    const body = typeof text === 'string' ? text : String(text ?? '');
    const normalized = normalizeAddress(typeof address === 'string' ? address : String(address ?? ''));
    const rawAddress = typeof address === 'string' ? address : String(address ?? '');

    if (!normalized || normalized.kind === 'unknown') {
      return {
        ok: false,
        address: rawAddress,
        text: body,
        error: `投递地址无效：${rawAddress}（应为 private:<QQ号> 或 group:<群号>）`,
      };
    }

    const target = `${normalized.kind}:${normalized.id}`;
    if (!body.trim()) {
      return { ok: false, address: target, text: body, error: '消息正文为空' };
    }

    const cfg = this.deps.getConfig();
    if (cfg.outboundMode === 'external') {
      this.deps.log.warn(`[发信] 当前把发信交给别的渠道，本插件看不到结果，因此这次不算发出：${target}`);
      return { ok: false, address: target, text: body, error: EXTERNAL_UNOBSERVABLE_ERROR };
    }
    if (cfg.outboundMode === 'bridge') {
      // 桥接模式下模型调的是 astrbot_send_message（由桌宠侧桥 World 执行），
      // 本扩展不直接发信；走到这里说明有人误用了自建发信路径。
      return {
        ok: false,
        address: target,
        text: body,
        error: '桥接模式下由 astrbot_send_message 发送，不走本扩展的 OneBot 通道',
      };
    }

    try {
      const client = this.getClient(cfg);
      // 表情解析全权归「QQ表情管理」扩展（resolveOutgoing 内部含掷骰兜底、标记转段、
      // 以及「表情管理关了就不发图」的治理闸）；本扩展只负责把结果发出去。
      const resolver = await loadStickerResolve();
      let bodyToSend = body;
      let segments: import('./onebot.ts').OutgoingSegment[] = [];
      if (resolver) {
        const out = resolver.resolveOutgoing(body, {
          info: (m) => this.deps.log.info(m),
        });
        bodyToSend = out.text;
        segments = out.segments;
        if (out.segments.some((s) => s.type === 'image') && bodyToSend !== body) {
          this.deps.log.info('[发信] 正文未带表情标记，已按概率自动补一张。');
        }
      }
      // 正文里的 [表情包:路径] 已由表情扩展转成图片段（对齐 qq-final 的做法）
      const receipt =
        normalized.kind === 'group'
          ? await client.sendGroup(normalized.id, bodyToSend, segments)
          : await client.sendPrivate(normalized.id, bodyToSend, segments);

      if (receipt.ok) {
        this.deps.log.info(`[发信] 已发出给 ${target}。`);
        // 分段发送时文字已送达；个别图片条失败不整体报错（报错会诱发重复发送），只记日志
        const raw = receipt.raw as { imageFailures?: string[] } | undefined;
        if (raw?.imageFailures?.length) {
          this.deps.log.warn(`[发信] ${target} 有 ${raw.imageFailures.length} 张图片没发出去：${sanitizeText(raw.imageFailures.join('；'))}`);
        }
      } else {
        this.deps.log.warn(`[发信] 这次没发出去给 ${target}：${sanitizeText(receipt.error ?? '未知原因')}`);
      }
      return { ...receipt, address: target, text: bodyToSend };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.deps.log.error(`[发信] 发送过程出错了（${target}）：${sanitizeText(reason)}。请检查发信地址与访问令牌。`);
      return { ok: false, address: target, text: body, error: `发信异常：${reason}` };
    }
  }

  /**
   * 按当前配置取用（必要时重建）HTTP 客户端，使地址、令牌、超时的热更新立即生效
   */
  private getClient(cfg: ProactiveConfig): OneBotHttpClient {
    const baseUrl = typeof cfg.outboundHttpUrl === 'string' && cfg.outboundHttpUrl.trim()
      ? cfg.outboundHttpUrl.trim()
      : DEFAULT_HTTP_URL;
    const accessToken = this.resolveToken(cfg);
    const timeout = Number(cfg.outboundHttpTimeoutMs);
    const timeoutMs = Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS;
    const key = `${baseUrl}\u0000${accessToken}\u0000${timeoutMs}`;

    if (!this.client || this.clientKey !== key) {
      this.client = new OneBotHttpClient({ baseUrl, accessToken, timeoutMs });
      this.clientKey = key;
    }
    return this.client;
  }
}
