/**
 * 主动回合提示构建器（NudgeBuilder）
 *
 * 只写「本轮任务」：发给谁、什么场景、用哪个渠道、这轮该用什么语气。长期状态与总原则在 ENV_PROMPT.md，
 * 两处不重复（方案 9.8.3）。整体长度受 V21 约束（≤400 字符），所以场景名和语气阶梯都用短版，
 * 短版统一放在 prompt/templates.ts 里维护，别在这里另起一套。
 */
import type { ProactiveScene, RoutinePhase, SessionActivity } from '../types.ts';
import { PHASE_SHORT, SCENE_SHORT, getToneShort } from './templates.ts';

export interface NudgeBuildContext {
  session: SessionActivity;
  scene: ProactiveScene;
  routinePhase: RoutinePhase;
  outboundTool: string;
  withNickname?: boolean;
  allowSilence?: boolean;
  /** 距上次对话已安静多少分钟，由调用方按真实活动时间算好。 */
  silenceMinutes?: number;
  /**
   * 发信通道：builtin=本扩展自建 OneBot；external=交给别的 World；
   * bridge=QQ 收发已交给 AstrBot 侧桥接管，由模型调 astrbot_send_message 发。
   */
  mode?: 'builtin' | 'external' | 'bridge';
}

/** 名字里可能带号码尾巴（如「小明(QQ:123)」），只取可读部分并限长，避免撑爆提示词。 */
function displayName(session: SessionActivity): string {
  const raw = String(session.label || '').trim();
  if (!raw) return session.address;
  const cleaned = raw.replace(/[(（]\s*(?:QQ|qq)?[:：]?\d+\s*[)）]\s*$/, '').trim();
  const name = cleaned || raw;
  return name.length > 12 ? `${name.slice(0, 12)}…` : name;
}

export class NudgeBuilder {
  static build(ctx: NudgeBuildContext): string {
    const { session, scene, routinePhase, outboundTool, allowSilence = true, silenceMinutes } = ctx;

    const target = displayName(session);
    const address = session.address;
    const sceneText = SCENE_SHORT[scene] || '日常闲聊';
    const phaseText = PHASE_SHORT[routinePhase] || '清醒时段';
    const quiet = Math.max(0, Math.round(silenceMinutes ?? 0));

    const lines: string[] = [];
    lines.push(`【主动搭话】现在主动找 ${target} 说句话。`);
    lines.push('');

    const bridge = ctx.mode === 'bridge';
    if (bridge) {
      // 桥接模式：这一轮不是 QQ 消息轮次，必须显式给会话，否则工具会拒发。
      const colon = address.indexOf(':');
      const convKind = colon > 0 ? address.slice(0, colon) : 'private';
      const convId = colon > 0 ? address.slice(colon + 1) : address;
      lines.push(
        `发送：调 \`${outboundTool}\`，conv_kind = "${convKind}"，conv_id = "${convId}"（原样照抄；这轮没有 QQ 消息，必须显式给会话）`
      );
      lines.push(`场景：${sceneText}，已安静 ${quiet} 分钟｜时段：${phaseText}`);
      lines.push(
        `配图：文字发出后调 \`qq_sticker_send\`，to = "${address}"（原样照抄）；配不配图由它掷骰，没过就纯文字收尾，别在发信工具里带图。`
      );
    } else {
      lines.push(`发送：调 \`${outboundTool}\`，to = "${address}"（原样照抄）`);
      lines.push(`场景：${sceneText}，已安静 ${quiet} 分钟｜时段：${phaseText}`);
      lines.push('配图：发送侧会按概率自动附带表情包（调表情工具挑过则用你挑的），正文不要提及图片。');
    }

    const wants: string[] = ['1~3 句，自然、别客服腔'];
    wants.push('别换发送渠道，系统只认这个工具的回执');

    const topics = (session.recentTopics || []).filter(Boolean);
    if (topics.length > 0) {
      const recent = topics
        .slice(-2)
        .map((t) => `“${String(t).slice(0, 12)}”`)
        .join('、');
      wants.push(`近期已聊 ${recent}，换个切入点`);
    }
    // 语气阶梯：他没回得越多，这一句就得越收，别越没回越追。
    const tone = getToneShort(session.unrepliedCount || 0);
    if (tone) wants.push(tone);

    lines.push(`要求：${wants.join('；')}。`);

    if (allowSilence) {
      lines.push('若此刻不适合打扰，直接 `end_turn`，配额不损失。');
    } else {
      lines.push('这一轮必须发出消息：请用上面的工具发送，不要用 `end_turn` 结束。');
    }

    return lines.join('\n');
  }
}
