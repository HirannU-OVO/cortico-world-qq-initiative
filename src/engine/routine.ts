/**
 * 拟人作息协同引擎（RoutineCoordinator）
 * 支持：
 * 1. 4 阶段生理相判定：WAKE（清醒活动）、NOON_LAZY（午休惬意）、NIGHT_QUIET（深夜安静）、SLEEP（深睡免打扰）；
 * 2. 睡眠免打扰守卫（深睡期严禁随机主动冒泡）；
 * 3. 边界跃迁检测（早安 / 午休 / 晚安播报触发点）。
 */
import type { ProactiveConfig } from '../config.ts';
import type { RoutinePhase } from '../types.ts';

export interface RoutineTransition {
  fromPhase: RoutinePhase;
  toPhase: RoutinePhase;
  scene?: 'routine_wake' | 'routine_noon' | 'routine_sleep';
}

export class RoutineCoordinator {
  /**
   * 将 "HH:mm" 格式时间转换为当天分钟数（0 ~ 1439）
   */
  static parseTimeToMinutes(timeStr: string): number {
    const parts = timeStr.trim().split(':');
    const h = parseInt(parts[0], 10) || 0;
    const m = parseInt(parts[1], 10) || 0;
    return (h * 60 + m) % 1440;
  }

  /**
   * 计算指定时间戳处于哪一个作息阶段
   */
  getPhase(cfg: ProactiveConfig, now: Date = new Date()): RoutinePhase {
    if (!cfg.routineEnabled) {
      return 'WAKE';
    }

    const currentMinutes = now.getHours() * 60 + now.getMinutes();

    const sleepStart = RoutineCoordinator.parseTimeToMinutes(cfg.sleepStart || '23:30');
    const sleepEnd = RoutineCoordinator.parseTimeToMinutes(cfg.sleepEnd || '08:00');
    const lazyStart = RoutineCoordinator.parseTimeToMinutes(cfg.lazyStart || '12:30');
    const lazyEnd = RoutineCoordinator.parseTimeToMinutes(cfg.lazyEnd || '14:00');

    // 1. 判断睡眠区间（跨午夜情况：如 23:30 到 08:00）
    if (sleepStart > sleepEnd) {
      if (currentMinutes >= sleepStart || currentMinutes < sleepEnd) {
        return 'SLEEP';
      }
    } else {
      if (currentMinutes >= sleepStart && currentMinutes < sleepEnd) {
        return 'SLEEP';
      }
    }

    // 2. 判断午休区间（一般在日间：如 12:30 到 14:00）
    if (lazyStart < lazyEnd) {
      if (currentMinutes >= lazyStart && currentMinutes < lazyEnd) {
        return 'NOON_LAZY';
      }
    }

    // 3. 判断深夜安静区间（22:00 ~ sleepStart 之间）
    const nightQuietStart = 22 * 60; // 22:00
    if (sleepStart > nightQuietStart) {
      if (currentMinutes >= nightQuietStart && currentMinutes < sleepStart) {
        return 'NIGHT_QUIET';
      }
    }

    // 4. 其余为清醒活跃期
    return 'WAKE';
  }

  /**
   * 免打扰守卫：检查当前生理相是否允许发起随机主动闲聊冒泡
   * SLEEP 期物理严禁任何主动打扰
   */
  isDndActive(cfg: ProactiveConfig, now: Date = new Date()): boolean {
    if (!cfg.routineEnabled) return false;
    return this.getPhase(cfg, now) === 'SLEEP';
  }

  /**
   * 检测是否发生了生理阶段的边界跃迁
   */
  checkTransition(
    lastPhase: RoutinePhase,
    currentPhase: RoutinePhase,
    announceEnabled: boolean
  ): RoutineTransition | null {
    if (lastPhase === currentPhase) {
      return null;
    }

    if (!announceEnabled) {
      return { fromPhase: lastPhase, toPhase: currentPhase };
    }

    let scene: 'routine_wake' | 'routine_noon' | 'routine_sleep' | undefined;

    // SLEEP -> WAKE（早晨醒来）
    if (lastPhase === 'SLEEP' && currentPhase === 'WAKE') {
      scene = 'routine_wake';
    }
    // * -> NOON_LAZY（进入午休）
    else if (currentPhase === 'NOON_LAZY') {
      scene = 'routine_noon';
    }
    // * -> SLEEP（准备入睡）
    else if (currentPhase === 'SLEEP') {
      scene = 'routine_sleep';
    }

    return {
      fromPhase: lastPhase,
      toPhase: currentPhase,
      scene,
    };
  }
}
