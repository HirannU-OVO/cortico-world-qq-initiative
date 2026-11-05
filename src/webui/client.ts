/**
 * QQ主动搭话 WebUI 客户端 Bundle
 * 内嵌于桌宠设置窗口的当前 World 页，完全遵照 WebUiClientBundle 标准
 */
import type { WebUiClientBundle, WebUiPanel, WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';
import './style.css';

interface SessionItem {
  address: string;
  kind: string;
  label: string;
  displayName?: string;
  lastInboundAt: string;
  lastProactiveAt: string;
  unrepliedCount: number;
  isBlockedByUnreplied: boolean;
}

interface StatusData {
  enabled: boolean;
  mode: string;
  whitelist: string[];
  whitelistPrivateIds: string[];
  whitelistGroupIds: string[];
  whitelistPrivateText: string;
  whitelistGroupText: string;
  dailyCount: number;
  dailyQuota: number;
  unrepliedThreshold: number;
  outboundTool: string;
  routineEnabled: boolean;
  phase: string;
  phaseLabel: string;
  sleepRange: string;
  lazyRange: string;
  sessions: SessionItem[];
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

function formatSessionDisplay(label: string | undefined, address: string): { displayName: string; optionLabel: string } {
  const rawAddr = String(address || '').trim();
  const isGroup = rawAddr.startsWith('group:');
  const pureId = rawAddr.replace(/^(private|group):/, '').replace(/\D/g, '') || rawAddr;
  const fallbackName = isGroup ? `群:${pureId}` : `QQ:${pureId}`;

  let name = (label || '').trim();
  if (
    !name ||
    name === rawAddr ||
    name === pureId ||
    name.startsWith('private:') ||
    name.startsWith('group:')
  ) {
    name = fallbackName;
  } else {
    const m = name.match(/^(.+?)\s*\((?:QQ:)?\d+\)$/);
    if (m && m[1]) {
      name = m[1].trim();
    }
  }

  return {
    displayName: name,
    optionLabel: `${name} (${rawAddr})`,
  };
}

const dashboardPanel: WebUiPanel = {
  mount(ctx: WebUiPanelContext) {
    const { ui, root, signal } = ctx;
    const msg = ui.msgline();

    const container = ui.h('div', 'proactive-container');
    root.append(msg, container);

    const render = async () => {
      container.innerHTML = '';

      let status: StatusData;
      try {
        status = await ctx.invoke<StatusData>('status');
      } catch (err) {
        msg.textContent = `加载状态失败: ${errText(err)}`;
        msg.classList.add('bad');
        return;
      }

      // 1. 状态指示卡片网格
      const grid = ui.h('div', 'proactive-grid');

      // 运行状态
      const statusCard = ui.h('div', 'proactive-card');
      const statusTitle = ui.h('div', 'proactive-card-title', '主动搭话');
      const statusVal = ui.h('div', 'proactive-card-value');
      const statusPill = ui.pill(status.enabled ? '● 运行中' : '○ 已停用', status.enabled ? 'on' : 'off');
      statusVal.append(statusPill);
      const statusDesc = ui.h('div', 'proactive-card-desc', `${status.mode === 'private' ? '只找私聊' : status.mode === 'group' ? '只在群里说' : '私聊和群都算'}`);
      statusCard.append(statusTitle, statusVal, statusDesc);

      // 当前作息
      const routineCard = ui.h('div', 'proactive-card');
      const routineTitle = ui.h('div', 'proactive-card-title', '当前时段');
      const routineVal = ui.h('div', 'proactive-card-value');
      const routineTone = status.phase === 'SLEEP' ? 'off' : status.phase === 'NOON_LAZY' ? 'plain' : 'on';
      const routinePill = ui.pill(status.phaseLabel, routineTone);
      routineVal.append(routinePill);
      const routineDesc = ui.h('div', 'proactive-card-desc', `睡觉时间 ${status.sleepRange}，这段时间一条都不发`);
      routineCard.append(routineTitle, routineVal, routineDesc);

      // 今日搭话用量
      const quotaCard = ui.h('div', 'proactive-card');
      const quotaTitle = ui.h('div', 'proactive-card-title', '今天说过几次');
      const quotaVal = ui.h('div', 'proactive-card-value', `${status.dailyCount} / ${status.dailyQuota} 次`);
      const quotaDesc = ui.h('div', 'proactive-card-desc', `连着 ${status.unrepliedThreshold} 次没回就先不说`);
      quotaCard.append(quotaTitle, quotaVal, quotaDesc);

      // 白名单与发信通道
      const channelCard = ui.h('div', 'proactive-card');
      const channelTitle = ui.h('div', 'proactive-card-title', '能主动找谁');
      const channelVal = ui.h('div', 'proactive-card-value', `${status.whitelist.length} 个对象`);
      const channelDesc = ui.h('div', 'proactive-card-desc', '只在白名单内主动开口');
      channelCard.append(channelTitle, channelVal, channelDesc);

      grid.append(statusCard, routineCard, quotaCard, channelCard);
      container.append(grid);

      // 2. 白名单分行配置与管理区（羽羽优化：纯数字输入，分私聊/群聊两行）
      const whitelistSection = ui.h('div', 'proactive-section');
      const wlHeader = ui.h('div', 'proactive-section-title', '📋 能主动找谁（只填数字，多个用逗号或换行分开）');

      const wlBox = ui.h('div', 'proactive-whitelist-box');

      // 私聊行
      const privRow = ui.h('div', 'proactive-whitelist-row');
      const privLabel = ui.h('label', 'proactive-whitelist-label', '私聊 QQ 号:');
      const privInput = ui.input({
        placeholder: '填 QQ 号，多个用逗号或换行分开',
        value: status.whitelistPrivateText || '',
      });
      privInput.style.flex = '1';
      privRow.append(privLabel, privInput);

      // 群聊行
      const groupRow = ui.h('div', 'proactive-whitelist-row');
      const groupLabel = ui.h('label', 'proactive-whitelist-label', '群号:');
      const groupInput = ui.input({
        placeholder: '填群号，多个用逗号或换行分开',
        value: status.whitelistGroupText || '',
      });
      groupInput.style.flex = '1';
      groupRow.append(groupLabel, groupInput);

      // 保存与操作
      const wlActionRow = ui.h('div', 'proactive-actions-row');
      const saveWlBtn = ui.button('💾 保存白名单设置', {
        size: 'sm',
        tone: 'primary',
        onClick: async () => {
          saveWlBtn.disabled = true;
          msg.textContent = '正在保存白名单设置...';
          msg.classList.remove('bad');
          try {
            const res = await ctx.invoke<{ status: string; message: string }>('update_whitelist', [
              { privateText: privInput.value.trim(), groupText: groupInput.value.trim() },
            ]);
            msg.textContent = res.message || '白名单已成功更新';
            msg.classList.remove('bad');
            void render();
          } catch (e) {
            msg.textContent = `保存白名单失败: ${errText(e)}`;
            msg.classList.add('bad');
          } finally {
            saveWlBtn.disabled = false;
          }
        },
      });
      const wlTips = ui.h('div', 'proactive-whitelist-tips', '留空 = 谁都不主动找；填了才会在这些人里挑');
      wlActionRow.append(saveWlBtn, wlTips);

      wlBox.append(privRow, groupRow, wlActionRow);
      whitelistSection.append(wlHeader, wlBox);
      container.append(whitelistSection);

      // 3. 快捷管理与搭话测试区
      const actionSection = ui.h('div', 'proactive-section');
      const actionHeader = ui.h('div', 'proactive-section-title', '🛠️ 测试与手动调整');

      const actionRow = ui.h('div', 'proactive-actions-row');

      const refreshBtn = ui.button('⟳ 刷新状态', {
        size: 'sm',
        onClick: () => {
          msg.textContent = '状态已刷新';
          msg.classList.remove('bad');
          void render();
        },
      });

      const resetQuotaBtn = ui.button('🔄 重置今日已发计数', {
        size: 'sm',
        onClick: async () => {
          try {
            await ctx.invoke('reset_quota');
            msg.textContent = '今日主动搭话已发计数已清零';
            msg.classList.remove('bad');
            void render();
          } catch (e) {
            msg.textContent = `重置失败: ${errText(e)}`;
            msg.classList.add('bad');
          }
        },
      });

      const resetAllBtn = ui.button('🔓 重置全部防扰状态', {
        size: 'sm',
        onClick: async () => {
          try {
            await ctx.invoke('reset_all');
            msg.textContent = '所有会话的未回复计数与防扰限制已全部解除';
            msg.classList.remove('bad');
            void render();
          } catch (e) {
            msg.textContent = `重置失败: ${errText(e)}`;
            msg.classList.add('bad');
          }
        },
      });

      actionRow.append(refreshBtn, resetQuotaBtn, resetAllBtn);

      // 搭话测试盒
      const testBox = ui.h('div', 'proactive-test-box');
      const testRow = ui.rowbar();

      // 构建所有候选目标（已记录会话 + 白名单列表去重）
      const candidateMap = new Map<string, string>();

      for (const s of status.sessions) {
        if (s.address) {
          const display = s.displayName || formatSessionDisplay(s.label, s.address).optionLabel;
          candidateMap.set(s.address, display);
        }
      }

      for (const item of status.whitelist) {
        const raw = String(item).trim();
        if (raw && !candidateMap.has(raw)) {
          candidateMap.set(raw, formatSessionDisplay(undefined, raw).optionLabel);
        }
      }

      for (const pid of status.whitelistPrivateIds) {
        const addr = `private:${pid}`;
        if (!candidateMap.has(addr)) {
          candidateMap.set(addr, formatSessionDisplay(undefined, addr).optionLabel);
        }
      }

      for (const gid of status.whitelistGroupIds) {
        const addr = `group:${gid}`;
        if (!candidateMap.has(addr)) {
          candidateMap.set(addr, formatSessionDisplay(undefined, addr).optionLabel);
        }
      }

      const defaultAddress =
        status.sessions[0]?.address ||
        status.whitelist[0] ||
        (status.whitelistPrivateIds[0] ? `private:${status.whitelistPrivateIds[0]}` : '');

      // 目标快捷选择下拉框
      const targetSelect = document.createElement('select');
      targetSelect.className = 'cortico-select proactive-target-select';

      for (const [addr, label] of candidateMap.entries()) {
        const opt = document.createElement('option');
        opt.value = addr;
        opt.textContent = label;
        targetSelect.appendChild(opt);
      }

      const customOpt = document.createElement('option');
      customOpt.value = '__custom__';
      customOpt.textContent = '✏️ 自定义输入其他地址...';
      targetSelect.appendChild(customOpt);

      const targetInput = ui.input({
        placeholder: '填 QQ 号，或完整地址（private:号码 / group:群号）',
        value: defaultAddress,
      });
      targetInput.style.flex = '1';

      if (candidateMap.has(defaultAddress)) {
        targetSelect.value = defaultAddress;
      } else {
        targetSelect.value = '__custom__';
      }

      targetSelect.addEventListener('change', () => {
        if (targetSelect.value !== '__custom__') {
          targetInput.value = targetSelect.value;
        } else {
          targetInput.focus();
        }
      });

      targetInput.addEventListener('input', () => {
        const val = targetInput.value.trim();
        if (candidateMap.has(val)) {
          targetSelect.value = val;
        } else {
          targetSelect.value = '__custom__';
        }
      });

      let sceneVal = 'idle_chat';
      const sceneSeg = ui.segmented(
        [
          { value: 'idle_chat', label: '日常闲聊' },
          { value: 'routine_wake', label: '早安问候' },
          { value: 'routine_noon', label: '午休关怀' },
          { value: 'routine_sleep', label: '晚安道别' },
        ],
        {
          value: sceneVal,
          onChange: (val) => {
            sceneVal = String(val);
          },
        }
      );

      const previewBox = ui.h('div', 'proactive-nudge-preview');
      previewBox.style.display = 'none';

      // 按钮 1：真实发起搭话测试（唤醒桌宠并派发任务）
      const realTriggerBtn = ui.button('🚀 触发主动搭话测试', {
        size: 'sm',
        tone: 'primary',
        onClick: async () => {
          realTriggerBtn.disabled = true;
          msg.textContent = '正在向桌宠宿主派发主动搭话任务...';
          msg.classList.remove('bad');
          try {
            const res = await ctx.invoke<{
              status: string;
              reason?: string;
              generatedNudge?: string;
              message?: string;
            }>('trigger_test', [{ address: targetInput.value.trim(), scene: sceneVal, force: true, previewOnly: false }]);

            if (res.status === 'dispatched' || res.status === 'pledged') {
              msg.textContent = res.message || '搭话任务已成功下发至桌宠！Bot 正在思考并执行发信。';
              if (res.generatedNudge) {
                previewBox.textContent = res.generatedNudge;
                previewBox.style.display = 'block';
              }
            } else {
              msg.textContent = `搭话未触发: ${res.reason || '拦截'}`;
              msg.classList.add('bad');
            }
            void render();
          } catch (err) {
            msg.textContent = `执行失败: ${errText(err)}`;
            msg.classList.add('bad');
          } finally {
            realTriggerBtn.disabled = false;
          }
        },
      });

      // 按钮 2：仅生成搭话词预览（不唤醒桌宠，只看 Prompt）
      const previewTriggerBtn = ui.button('👁️ 仅生成搭话词预览', {
        size: 'sm',
        onClick: async () => {
          previewTriggerBtn.disabled = true;
          msg.textContent = '正在生成主动搭话提示词预览...';
          msg.classList.remove('bad');
          try {
            const res = await ctx.invoke<{
              status: string;
              reason?: string;
              generatedNudge?: string;
              message?: string;
            }>('trigger_test', [{ address: targetInput.value.trim(), scene: sceneVal, force: true, previewOnly: true }]);

            if (res.generatedNudge) {
              msg.textContent = res.message || '搭话提示词生成完成（仅预览，未唤醒桌宠）';
              previewBox.textContent = res.generatedNudge;
              previewBox.style.display = 'block';
            } else {
              msg.textContent = `生成失败: ${res.reason || '拦截'}`;
              msg.classList.add('bad');
            }
          } catch (err) {
            msg.textContent = `预览失败: ${errText(err)}`;
            msg.classList.add('bad');
          } finally {
            previewTriggerBtn.disabled = false;
          }
        },
      });

      testRow.append(targetSelect, targetInput, sceneSeg.el, realTriggerBtn, previewTriggerBtn);
      testBox.append(testRow, previewBox);

      actionSection.append(actionHeader, actionRow, testBox);
      container.append(actionSection);

      // 4. 会话活跃度与防扰监控表
      const sessionSection = ui.h('div', 'proactive-section');
      const sessionHeader = ui.h('div', 'proactive-section-title', `活跃会话防扰监控 (${status.sessions.length})`);

      if (status.sessions.length === 0) {
        const empty = ui.h('div', 'proactive-session-empty', '还没有聊过天，暂时没有人可以主动找。');
        sessionSection.append(sessionHeader, empty);
      } else {
        const table = ui.h('table', 'proactive-session-table');
        const thead = ui.h('thead');
        thead.innerHTML = `
          <tr>
            <th>对象</th>
            <th>聊天类型</th>
            <th>对方最后说话</th>
            <th>上次主动找ta</th>
            <th>连着没回</th>
            <th>现在</th>
            <th>操作</th>
          </tr>
        `;
        table.append(thead);

        const tbody = ui.h('tbody');
        for (const s of status.sessions) {
          const tr = ui.h('tr');

          const formatted = s.displayName || formatSessionDisplay(s.label, s.address).optionLabel;
          const tdTarget = ui.h('td', '', formatted);
          const tdKind = ui.h('td', '', s.kind === 'group' ? '群聊' : '私聊');
          const tdIn = ui.h('td', '', s.lastInboundAt || '尚无记录');
          const tdOut = ui.h('td', '', s.lastProactiveAt || '尚无记录');
          const tdCount = ui.h('td', '', `${s.unrepliedCount} / ${status.unrepliedThreshold}`);

          const tdStatus = ui.h('td');
          const statusBadge = s.isBlockedByUnreplied
            ? ui.pill('先不说', 'off')
            : ui.pill('可以再说', 'on');
          tdStatus.append(statusBadge);

          const tdAction = ui.h('td');
          if (s.unrepliedCount > 0) {
            const resetBtn = ui.button(`🔓 解锁（已 ${s.unrepliedCount} 次没回）`, {
              size: 'sm',
              onClick: async () => {
                try {
                  const res = await ctx.invoke<{ status: string; message: string }>('reset_session', [{ address: s.address }]);
                  msg.textContent = res.message || `已解除会话 ${s.address} 的防扰状态`;
                  msg.classList.remove('bad');
                  void render();
                } catch (e) {
                  msg.textContent = `重置失败: ${errText(e)}`;
                  msg.classList.add('bad');
                }
              },
            });
            tdAction.append(resetBtn);
          } else {
            const normalBadge = ui.pill('✓ 无限制', 'on');
            tdAction.append(normalBadge);
          }

          tr.append(tdTarget, tdKind, tdIn, tdOut, tdCount, tdStatus, tdAction);
          tbody.append(tr);
        }

        table.append(tbody);
        sessionSection.append(sessionHeader, table);
      }

      container.append(sessionSection);
    };

    void render();
  },
  unmount() {},
};

const bundle: WebUiClientBundle = {
  panels: {
    dashboard: dashboardPanel,
  },
};

export default bundle;
