// src/webui/client.ts
var errText = (err) => err instanceof Error ? err.message : String(err);
function formatSessionDisplay(label, address) {
  const rawAddr = String(address || "").trim();
  const isGroup = rawAddr.startsWith("group:");
  const pureId = rawAddr.replace(/^(private|group):/, "").replace(/\D/g, "") || rawAddr;
  const fallbackName = isGroup ? `\u7FA4:${pureId}` : `QQ:${pureId}`;
  let name = (label || "").trim();
  if (!name || name === rawAddr || name === pureId || name.startsWith("private:") || name.startsWith("group:")) {
    name = fallbackName;
  } else {
    const m = name.match(/^(.+?)\s*\((?:QQ:)?\d+\)$/);
    if (m && m[1]) {
      name = m[1].trim();
    }
  }
  return {
    displayName: name,
    optionLabel: `${name} (${rawAddr})`
  };
}
var dashboardPanel = {
  mount(ctx) {
    const { ui, root, signal } = ctx;
    const msg = ui.msgline();
    const container = ui.h("div", "proactive-container");
    root.append(msg, container);
    const render = async () => {
      container.innerHTML = "";
      let status;
      try {
        status = await ctx.invoke("status");
      } catch (err) {
        msg.textContent = `\u52A0\u8F7D\u72B6\u6001\u5931\u8D25: ${errText(err)}`;
        msg.classList.add("bad");
        return;
      }
      const grid = ui.h("div", "proactive-grid");
      const statusCard = ui.h("div", "proactive-card");
      const statusTitle = ui.h("div", "proactive-card-title", "\u4E3B\u52A8\u642D\u8BDD");
      const statusVal = ui.h("div", "proactive-card-value");
      const statusPill = ui.pill(status.enabled ? "\u25CF \u8FD0\u884C\u4E2D" : "\u25CB \u5DF2\u505C\u7528", status.enabled ? "on" : "off");
      statusVal.append(statusPill);
      const statusDesc = ui.h("div", "proactive-card-desc", `${status.mode === "private" ? "\u53EA\u627E\u79C1\u804A" : status.mode === "group" ? "\u53EA\u5728\u7FA4\u91CC\u8BF4" : "\u79C1\u804A\u548C\u7FA4\u90FD\u7B97"}`);
      statusCard.append(statusTitle, statusVal, statusDesc);
      const routineCard = ui.h("div", "proactive-card");
      const routineTitle = ui.h("div", "proactive-card-title", "\u5F53\u524D\u65F6\u6BB5");
      const routineVal = ui.h("div", "proactive-card-value");
      const routineTone = status.phase === "SLEEP" ? "off" : status.phase === "NOON_LAZY" ? "plain" : "on";
      const routinePill = ui.pill(status.phaseLabel, routineTone);
      routineVal.append(routinePill);
      const routineDesc = ui.h("div", "proactive-card-desc", `\u7761\u89C9\u65F6\u95F4 ${status.sleepRange}\uFF0C\u8FD9\u6BB5\u65F6\u95F4\u4E00\u6761\u90FD\u4E0D\u53D1`);
      routineCard.append(routineTitle, routineVal, routineDesc);
      const quotaCard = ui.h("div", "proactive-card");
      const quotaTitle = ui.h("div", "proactive-card-title", "\u4ECA\u5929\u8BF4\u8FC7\u51E0\u6B21");
      const quotaVal = ui.h("div", "proactive-card-value", `${status.dailyCount} / ${status.dailyQuota} \u6B21`);
      const quotaDesc = ui.h("div", "proactive-card-desc", `\u8FDE\u7740 ${status.unrepliedThreshold} \u6B21\u6CA1\u56DE\u5C31\u5148\u4E0D\u8BF4`);
      quotaCard.append(quotaTitle, quotaVal, quotaDesc);
      const channelCard = ui.h("div", "proactive-card");
      const channelTitle = ui.h("div", "proactive-card-title", "\u80FD\u4E3B\u52A8\u627E\u8C01");
      const channelVal = ui.h("div", "proactive-card-value", `${status.whitelist.length} \u4E2A\u5BF9\u8C61`);
      const channelDesc = ui.h("div", "proactive-card-desc", "\u53EA\u5728\u767D\u540D\u5355\u5185\u4E3B\u52A8\u5F00\u53E3");
      channelCard.append(channelTitle, channelVal, channelDesc);
      grid.append(statusCard, routineCard, quotaCard, channelCard);
      container.append(grid);
      const whitelistSection = ui.h("div", "proactive-section");
      const wlHeader = ui.h("div", "proactive-section-title", "\u{1F4CB} \u80FD\u4E3B\u52A8\u627E\u8C01\uFF08\u53EA\u586B\u6570\u5B57\uFF0C\u591A\u4E2A\u7528\u9017\u53F7\u6216\u6362\u884C\u5206\u5F00\uFF09");
      const wlBox = ui.h("div", "proactive-whitelist-box");
      const privRow = ui.h("div", "proactive-whitelist-row");
      const privLabel = ui.h("label", "proactive-whitelist-label", "\u79C1\u804A QQ \u53F7:");
      const privInput = ui.input({
        placeholder: "\u586B QQ \u53F7\uFF0C\u591A\u4E2A\u7528\u9017\u53F7\u6216\u6362\u884C\u5206\u5F00",
        value: status.whitelistPrivateText || ""
      });
      privInput.style.flex = "1";
      privRow.append(privLabel, privInput);
      const groupRow = ui.h("div", "proactive-whitelist-row");
      const groupLabel = ui.h("label", "proactive-whitelist-label", "\u7FA4\u53F7:");
      const groupInput = ui.input({
        placeholder: "\u586B\u7FA4\u53F7\uFF0C\u591A\u4E2A\u7528\u9017\u53F7\u6216\u6362\u884C\u5206\u5F00",
        value: status.whitelistGroupText || ""
      });
      groupInput.style.flex = "1";
      groupRow.append(groupLabel, groupInput);
      const wlActionRow = ui.h("div", "proactive-actions-row");
      const saveWlBtn = ui.button("\u{1F4BE} \u4FDD\u5B58\u767D\u540D\u5355\u8BBE\u7F6E", {
        size: "sm",
        tone: "primary",
        onClick: async () => {
          saveWlBtn.disabled = true;
          msg.textContent = "\u6B63\u5728\u4FDD\u5B58\u767D\u540D\u5355\u8BBE\u7F6E...";
          msg.classList.remove("bad");
          try {
            const res = await ctx.invoke("update_whitelist", [
              { privateText: privInput.value.trim(), groupText: groupInput.value.trim() }
            ]);
            msg.textContent = res.message || "\u767D\u540D\u5355\u5DF2\u6210\u529F\u66F4\u65B0";
            msg.classList.remove("bad");
            void render();
          } catch (e) {
            msg.textContent = `\u4FDD\u5B58\u767D\u540D\u5355\u5931\u8D25: ${errText(e)}`;
            msg.classList.add("bad");
          } finally {
            saveWlBtn.disabled = false;
          }
        }
      });
      const wlTips = ui.h("div", "proactive-whitelist-tips", "\u7559\u7A7A = \u8C01\u90FD\u4E0D\u4E3B\u52A8\u627E\uFF1B\u586B\u4E86\u624D\u4F1A\u5728\u8FD9\u4E9B\u4EBA\u91CC\u6311");
      wlActionRow.append(saveWlBtn, wlTips);
      wlBox.append(privRow, groupRow, wlActionRow);
      whitelistSection.append(wlHeader, wlBox);
      container.append(whitelistSection);
      const actionSection = ui.h("div", "proactive-section");
      const actionHeader = ui.h("div", "proactive-section-title", "\u{1F6E0}\uFE0F \u6D4B\u8BD5\u4E0E\u624B\u52A8\u8C03\u6574");
      const actionRow = ui.h("div", "proactive-actions-row");
      const refreshBtn = ui.button("\u27F3 \u5237\u65B0\u72B6\u6001", {
        size: "sm",
        onClick: () => {
          msg.textContent = "\u72B6\u6001\u5DF2\u5237\u65B0";
          msg.classList.remove("bad");
          void render();
        }
      });
      const resetQuotaBtn = ui.button("\u{1F504} \u91CD\u7F6E\u4ECA\u65E5\u5DF2\u53D1\u8BA1\u6570", {
        size: "sm",
        onClick: async () => {
          try {
            await ctx.invoke("reset_quota");
            msg.textContent = "\u4ECA\u65E5\u4E3B\u52A8\u642D\u8BDD\u5DF2\u53D1\u8BA1\u6570\u5DF2\u6E05\u96F6";
            msg.classList.remove("bad");
            void render();
          } catch (e) {
            msg.textContent = `\u91CD\u7F6E\u5931\u8D25: ${errText(e)}`;
            msg.classList.add("bad");
          }
        }
      });
      const resetAllBtn = ui.button("\u{1F513} \u91CD\u7F6E\u5168\u90E8\u9632\u6270\u72B6\u6001", {
        size: "sm",
        onClick: async () => {
          try {
            await ctx.invoke("reset_all");
            msg.textContent = "\u6240\u6709\u4F1A\u8BDD\u7684\u672A\u56DE\u590D\u8BA1\u6570\u4E0E\u9632\u6270\u9650\u5236\u5DF2\u5168\u90E8\u89E3\u9664";
            msg.classList.remove("bad");
            void render();
          } catch (e) {
            msg.textContent = `\u91CD\u7F6E\u5931\u8D25: ${errText(e)}`;
            msg.classList.add("bad");
          }
        }
      });
      actionRow.append(refreshBtn, resetQuotaBtn, resetAllBtn);
      const testBox = ui.h("div", "proactive-test-box");
      const testRow = ui.rowbar();
      const candidateMap = /* @__PURE__ */ new Map();
      for (const s of status.sessions) {
        if (s.address) {
          const display = s.displayName || formatSessionDisplay(s.label, s.address).optionLabel;
          candidateMap.set(s.address, display);
        }
      }
      for (const item of status.whitelist) {
        const raw = String(item).trim();
        if (raw && !candidateMap.has(raw)) {
          candidateMap.set(raw, formatSessionDisplay(void 0, raw).optionLabel);
        }
      }
      for (const pid of status.whitelistPrivateIds) {
        const addr = `private:${pid}`;
        if (!candidateMap.has(addr)) {
          candidateMap.set(addr, formatSessionDisplay(void 0, addr).optionLabel);
        }
      }
      for (const gid of status.whitelistGroupIds) {
        const addr = `group:${gid}`;
        if (!candidateMap.has(addr)) {
          candidateMap.set(addr, formatSessionDisplay(void 0, addr).optionLabel);
        }
      }
      const defaultAddress = status.sessions[0]?.address || status.whitelist[0] || (status.whitelistPrivateIds[0] ? `private:${status.whitelistPrivateIds[0]}` : "");
      const targetSelect = document.createElement("select");
      targetSelect.className = "cortico-select proactive-target-select";
      for (const [addr, label] of candidateMap.entries()) {
        const opt = document.createElement("option");
        opt.value = addr;
        opt.textContent = label;
        targetSelect.appendChild(opt);
      }
      const customOpt = document.createElement("option");
      customOpt.value = "__custom__";
      customOpt.textContent = "\u270F\uFE0F \u81EA\u5B9A\u4E49\u8F93\u5165\u5176\u4ED6\u5730\u5740...";
      targetSelect.appendChild(customOpt);
      const targetInput = ui.input({
        placeholder: "\u586B QQ \u53F7\uFF0C\u6216\u5B8C\u6574\u5730\u5740\uFF08private:\u53F7\u7801 / group:\u7FA4\u53F7\uFF09",
        value: defaultAddress
      });
      targetInput.style.flex = "1";
      if (candidateMap.has(defaultAddress)) {
        targetSelect.value = defaultAddress;
      } else {
        targetSelect.value = "__custom__";
      }
      targetSelect.addEventListener("change", () => {
        if (targetSelect.value !== "__custom__") {
          targetInput.value = targetSelect.value;
        } else {
          targetInput.focus();
        }
      });
      targetInput.addEventListener("input", () => {
        const val = targetInput.value.trim();
        if (candidateMap.has(val)) {
          targetSelect.value = val;
        } else {
          targetSelect.value = "__custom__";
        }
      });
      let sceneVal = "idle_chat";
      const sceneSeg = ui.segmented(
        [
          { value: "idle_chat", label: "\u65E5\u5E38\u95F2\u804A" },
          { value: "routine_wake", label: "\u65E9\u5B89\u95EE\u5019" },
          { value: "routine_noon", label: "\u5348\u4F11\u5173\u6000" },
          { value: "routine_sleep", label: "\u665A\u5B89\u9053\u522B" }
        ],
        {
          value: sceneVal,
          onChange: (val) => {
            sceneVal = String(val);
          }
        }
      );
      const previewBox = ui.h("div", "proactive-nudge-preview");
      previewBox.style.display = "none";
      const realTriggerBtn = ui.button("\u{1F680} \u89E6\u53D1\u4E3B\u52A8\u642D\u8BDD\u6D4B\u8BD5", {
        size: "sm",
        tone: "primary",
        onClick: async () => {
          realTriggerBtn.disabled = true;
          msg.textContent = "\u6B63\u5728\u5411\u684C\u5BA0\u5BBF\u4E3B\u6D3E\u53D1\u4E3B\u52A8\u642D\u8BDD\u4EFB\u52A1...";
          msg.classList.remove("bad");
          try {
            const res = await ctx.invoke("trigger_test", [{ address: targetInput.value.trim(), scene: sceneVal, force: true, previewOnly: false }]);
            if (res.status === "dispatched" || res.status === "pledged") {
              msg.textContent = res.message || "\u642D\u8BDD\u4EFB\u52A1\u5DF2\u6210\u529F\u4E0B\u53D1\u81F3\u684C\u5BA0\uFF01Bot \u6B63\u5728\u601D\u8003\u5E76\u6267\u884C\u53D1\u4FE1\u3002";
              if (res.generatedNudge) {
                previewBox.textContent = res.generatedNudge;
                previewBox.style.display = "block";
              }
            } else {
              msg.textContent = `\u642D\u8BDD\u672A\u89E6\u53D1: ${res.reason || "\u62E6\u622A"}`;
              msg.classList.add("bad");
            }
            void render();
          } catch (err) {
            msg.textContent = `\u6267\u884C\u5931\u8D25: ${errText(err)}`;
            msg.classList.add("bad");
          } finally {
            realTriggerBtn.disabled = false;
          }
        }
      });
      const previewTriggerBtn = ui.button("\u{1F441}\uFE0F \u4EC5\u751F\u6210\u642D\u8BDD\u8BCD\u9884\u89C8", {
        size: "sm",
        onClick: async () => {
          previewTriggerBtn.disabled = true;
          msg.textContent = "\u6B63\u5728\u751F\u6210\u4E3B\u52A8\u642D\u8BDD\u63D0\u793A\u8BCD\u9884\u89C8...";
          msg.classList.remove("bad");
          try {
            const res = await ctx.invoke("trigger_test", [{ address: targetInput.value.trim(), scene: sceneVal, force: true, previewOnly: true }]);
            if (res.generatedNudge) {
              msg.textContent = res.message || "\u642D\u8BDD\u63D0\u793A\u8BCD\u751F\u6210\u5B8C\u6210\uFF08\u4EC5\u9884\u89C8\uFF0C\u672A\u5524\u9192\u684C\u5BA0\uFF09";
              previewBox.textContent = res.generatedNudge;
              previewBox.style.display = "block";
            } else {
              msg.textContent = `\u751F\u6210\u5931\u8D25: ${res.reason || "\u62E6\u622A"}`;
              msg.classList.add("bad");
            }
          } catch (err) {
            msg.textContent = `\u9884\u89C8\u5931\u8D25: ${errText(err)}`;
            msg.classList.add("bad");
          } finally {
            previewTriggerBtn.disabled = false;
          }
        }
      });
      testRow.append(targetSelect, targetInput, sceneSeg.el, realTriggerBtn, previewTriggerBtn);
      testBox.append(testRow, previewBox);
      actionSection.append(actionHeader, actionRow, testBox);
      container.append(actionSection);
      const sessionSection = ui.h("div", "proactive-section");
      const sessionHeader = ui.h("div", "proactive-section-title", `\u6D3B\u8DC3\u4F1A\u8BDD\u9632\u6270\u76D1\u63A7 (${status.sessions.length})`);
      if (status.sessions.length === 0) {
        const empty = ui.h("div", "proactive-session-empty", "\u8FD8\u6CA1\u6709\u804A\u8FC7\u5929\uFF0C\u6682\u65F6\u6CA1\u6709\u4EBA\u53EF\u4EE5\u4E3B\u52A8\u627E\u3002");
        sessionSection.append(sessionHeader, empty);
      } else {
        const table = ui.h("table", "proactive-session-table");
        const thead = ui.h("thead");
        thead.innerHTML = `
          <tr>
            <th>\u5BF9\u8C61</th>
            <th>\u804A\u5929\u7C7B\u578B</th>
            <th>\u5BF9\u65B9\u6700\u540E\u8BF4\u8BDD</th>
            <th>\u4E0A\u6B21\u4E3B\u52A8\u627Eta</th>
            <th>\u8FDE\u7740\u6CA1\u56DE</th>
            <th>\u73B0\u5728</th>
            <th>\u64CD\u4F5C</th>
          </tr>
        `;
        table.append(thead);
        const tbody = ui.h("tbody");
        for (const s of status.sessions) {
          const tr = ui.h("tr");
          const formatted = s.displayName || formatSessionDisplay(s.label, s.address).optionLabel;
          const tdTarget = ui.h("td", "", formatted);
          const tdKind = ui.h("td", "", s.kind === "group" ? "\u7FA4\u804A" : "\u79C1\u804A");
          const tdIn = ui.h("td", "", s.lastInboundAt || "\u5C1A\u65E0\u8BB0\u5F55");
          const tdOut = ui.h("td", "", s.lastProactiveAt || "\u5C1A\u65E0\u8BB0\u5F55");
          const tdCount = ui.h("td", "", `${s.unrepliedCount} / ${status.unrepliedThreshold}`);
          const tdStatus = ui.h("td");
          const statusBadge = s.isBlockedByUnreplied ? ui.pill("\u5148\u4E0D\u8BF4", "off") : ui.pill("\u53EF\u4EE5\u518D\u8BF4", "on");
          tdStatus.append(statusBadge);
          const tdAction = ui.h("td");
          if (s.unrepliedCount > 0) {
            const resetBtn = ui.button(`\u{1F513} \u89E3\u9501\uFF08\u5DF2 ${s.unrepliedCount} \u6B21\u6CA1\u56DE\uFF09`, {
              size: "sm",
              onClick: async () => {
                try {
                  const res = await ctx.invoke("reset_session", [{ address: s.address }]);
                  msg.textContent = res.message || `\u5DF2\u89E3\u9664\u4F1A\u8BDD ${s.address} \u7684\u9632\u6270\u72B6\u6001`;
                  msg.classList.remove("bad");
                  void render();
                } catch (e) {
                  msg.textContent = `\u91CD\u7F6E\u5931\u8D25: ${errText(e)}`;
                  msg.classList.add("bad");
                }
              }
            });
            tdAction.append(resetBtn);
          } else {
            const normalBadge = ui.pill("\u2713 \u65E0\u9650\u5236", "on");
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
  unmount() {
  }
};
var bundle = {
  panels: {
    dashboard: dashboardPanel
  }
};
var client_default = bundle;
export {
  client_default as default
};
