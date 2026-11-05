/**
 * 抽象发信契约定义与回执校验代理
 * 完全解耦底层协议扩展，支持灵活配置工具名与字段映射
 */
import type { OutboundContract } from '../types.ts';

export interface VerifiedOutboundCall {
  toolName: string;
  target: string;
  text: string;
  matched: boolean;
}

export interface NormalizedAddress {
  kind: 'private' | 'group' | 'unknown';
  id: string;
}

/**
 * 规范化解析地址表达，提取类型与纯数字标识
 * 支持：private:123456, group:654321, qq:private:123456, qq:group:654321 以及纯数字 ID
 */
export function normalizeAddress(addr: string): NormalizedAddress | null {
  if (!addr || typeof addr !== 'string') return null;
  const trimmed = addr.trim();
  if (!trimmed) return null;

  const match = trimmed.match(/(?:^|:)(private|group):(\d+)/i);
  if (match) {
    return {
      kind: match[1].toLowerCase() as 'private' | 'group',
      id: match[2],
    };
  }

  // 纯数字默认视为私聊
  if (/^\d+$/.test(trimmed)) {
    return {
      kind: 'private',
      id: trimmed,
    };
  }

  return {
    kind: 'unknown',
    id: trimmed,
  };
}

/**
 * 精准比对两个地址是否指向同一会话实体
 * 严格区分群聊（group）与私聊（private），避免相同 ID 误判
 */
export function matchesAddress(rawAddress: string, targetAddress: string): boolean {
  if (!rawAddress || !targetAddress) return false;
  if (rawAddress.trim() === targetAddress.trim()) return true;

  const a = normalizeAddress(rawAddress);
  const b = normalizeAddress(targetAddress);
  if (!a || !b) return false;

  // 若双方类型已知，则必须类型和 ID 同时相等
  if (a.kind !== 'unknown' && b.kind !== 'unknown') {
    return a.kind === b.kind && a.id === b.id;
  }

  // 若任一方为 unknown，则 fallback 到比较去除前缀后的 ID
  return a.id === b.id;
}

export class OutboundAdapter {
  private contract: OutboundContract;

  constructor(contract: OutboundContract) {
    this.contract = contract;
  }

  get contractConfig(): Readonly<OutboundContract> {
    return this.contract;
  }

  updateContract(contract: OutboundContract): void {
    this.contract = contract;
  }

  get toolName(): string {
    return this.contract.toolName;
  }

  /**
   * 规范化地址匹配：支持带有协议前缀或无前缀的比对（如 private:123 与 qq:private:123）
   */
  matchesAddress(rawAddress: string, targetAddress: string): boolean {
    return matchesAddress(rawAddress, targetAddress);
  }

  /**
   * 校验单个工具调用是否命中了主动搭话的发信契约，并提取发送目标与正文
   */
  verifyToolExecution(toolName: string, args: Record<string, unknown>, expectedTarget?: string): VerifiedOutboundCall {
    if (toolName !== this.contract.toolName) {
      return {
        toolName,
        target: '',
        text: '',
        matched: false,
      };
    }

    const toVal = args[this.contract.toField];
    const textVal = args[this.contract.textField];

    const target = typeof toVal === 'string' ? toVal : typeof toVal === 'number' ? String(toVal) : '';
    const text = typeof textVal === 'string' ? textVal : '';

    if (!target) {
      return {
        toolName,
        target: '',
        text,
        matched: false,
      };
    }

    if (expectedTarget && !this.matchesAddress(target, expectedTarget)) {
      return {
        toolName,
        target,
        text,
        matched: false,
      };
    }

    return {
      toolName,
      target,
      text,
      matched: true,
    };
  }
}
