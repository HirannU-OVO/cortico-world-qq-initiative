/**
 * 主动搭话发信工具 qq_initiative_send
 * 把主动回合里的一次发言落到真实 QQ 会话：成功拿平台回执并核销质押，失败交回世界回滚，绝不抛错。
 */
import type { ToolDef } from 'cortico/core/types.ts';
import type { ProactiveConfig } from '../config.ts';
import { normalizeAddress } from '../outbound/adapter.ts';
import type { OutboundSender } from '../outbound/sender.ts';
import { BUILTIN_SEND_TOOL } from '../outbound/sender.ts';
import type { SendReceipt } from '../types.ts';

export interface SendToolDeps {
  getConfig(): ProactiveConfig;
  sender: OutboundSender;
  /** 主动回合内发送成功后记账；返回是否核销成功（无在途质押时返回 false 但不报错） */
  onSent(address: string, text: string, receipt: SendReceipt): boolean;
  onSendFailed(address: string, reason: string): void;
}

export const QQ_PROACTIVE_SEND_TOOL = BUILTIN_SEND_TOOL;

const SEND_TOOL_DESCRIPTION =
  '主动搭话专用发信渠道：向指定 QQ 私聊或群发送一条消息。to 必须是 "private:<QQ号>" 或 "group:<群号>"（直接照抄提示词里给的投递地址）。一次说完整段。';

const SEND_TOOL_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {
    to: {
      type: 'string',
      description: '投递地址：private:<QQ号> 或 group:<群号>',
    },
    text: {
      type: 'string',
      description: '消息正文（1~3 句，说完整）',
    },
  },
  required: ['to', 'text'],
};

function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  return String(value);
}

/** 结算与回滚回调都不允许把异常抛回工具调用方 */
function safeNotifyFailed(deps: SendToolDeps, address: string, reason: string): void {
  try {
    deps.onSendFailed(address, reason);
  } catch {
    // 世界侧回滚回调自身异常时保持静默：发信结果已经确定，不能反向污染工具回执
  }
}

export function buildQqProactiveSendTool(deps: SendToolDeps): ToolDef {
  return {
    name: QQ_PROACTIVE_SEND_TOOL,
    description: SEND_TOOL_DESCRIPTION,
    parameters: SEND_TOOL_PARAMETERS,
    tags: ['speak'],
    barrierAfter: true,
    endsTurn: true,
    handler: async (args: Record<string, unknown>): Promise<string> => {
      const to = asText(args?.to).trim();
      const text = asText(args?.text).trim();
      const normalized = normalizeAddress(to);
      const address = normalized && normalized.kind !== 'unknown' ? `${normalized.kind}:${normalized.id}` : to;

      if (!text) {
        safeNotifyFailed(deps, address, '消息正文为空');
        return '[send failed] 消息正文为空，已取消发送。';
      }

      let receipt: SendReceipt;
      try {
        receipt = await deps.sender.send(to, text);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        safeNotifyFailed(deps, address, reason);
        return `[send failed] ${reason}`;
      }

      if (!receipt || !receipt.ok) {
        const reason = (receipt && receipt.error) || 'unknown_error';
        safeNotifyFailed(deps, (receipt && receipt.address) || address, reason);
        return `[send failed] ${reason}`;
      }

      const target = receipt.address || address;
      let committed = false;
      try {
        committed = deps.onSent(target, receipt.text || text, receipt);
      } catch {
        committed = false;
      }

      const messageId = receipt.messageId === undefined || receipt.messageId === null ? 'unknown' : String(receipt.messageId);
      const suffix = committed ? '' : '（本次无在途质押，未计入主动配额）';
      return `成功已发送到 ${target}（message_id=${messageId}）${suffix}`;
    },
  };
}
