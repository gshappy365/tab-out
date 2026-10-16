(function (root) {
  'use strict';

  function createRemoteController(api) {
    const muse = (root.TabOutMuseFocus || require('./muse-focus.js')).createMuseFocus(api);
    const split = (root.TabOutSplit || require('./split-navigation.js')).createSplitNavigator(api);
    const dashboardUrl = api.runtime.getURL('index.html');
    const commands = new Set([
      'show-dashboard', 'navigate-left', 'navigate-right', 'navigate-up',
      'navigate-down', 'confirm-selection', 'cancel-selection',
    ]);
    let commandQueue = Promise.resolve();
    let showingDashboard = false;

    function isDashboard(tab) {
      const url = tab?.url || tab?.pendingUrl || '';
      return url.split(/[?#]/)[0] === dashboardUrl || /^chrome:\/\/newtab\/?$/.test(url);
    }

    const stateKey = windowId => `remote.window.${windowId}`;

    async function getState(windowId) {
      const key = stateKey(windowId);
      return (await api.storage.session.get(key))[key] || null;
    }

    async function saveState(windowId, state) {
      await api.storage.session.set({ [stateKey(windowId)]: state });
    }

    async function dashboardState(tab) {
      const context = await split.inspect(tab.id);
      const stored = await getState(tab.windowId);
      const previous = stored?.dashboardTabId === tab.id ? stored : null;
      if (!context) {
        if (!previous) return null;
        const state = { ...previous, split: false, originalTabId: null };
        if (previous.split) Object.assign(state, { enabled: false, sourceTabId: null, selectedTabId: null });
        await saveState(tab.windowId, state);
        return state;
      }
      const state = {
        ...previous, enabled: true, windowId: tab.windowId, dashboardTabId: tab.id,
        sourceTabId: previous?.sourceTabId ?? context.partner.id,
        selectedTabId: previous?.dashboardTabId === tab.id ? previous.selectedTabId : context.partner.id,
        split: true, originalTabId: context.session?.originalTabId ?? null,
      };
      await saveState(tab.windowId, state);
      return state;
    }

    async function sendToDashboard(state, type, extra = {}) {
      for (let attempt = 0; attempt < 30; attempt++) {
        let response;
        try {
          response = await api.runtime.sendMessage({
            type, targetTabId: state.dashboardTabId, windowId: state.windowId, ...extra,
          });
        } catch { /* The newly created extension page may still be loading. */ }
        if (response?.ok) return response;
        if (response?.error) throw new Error(response.error);
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error('标签总览尚未就绪，请稍后再次按菜单。');
    }

    async function showDashboard(windowId, tabs) {
      const active = tabs.find(tab => tab.active);
      const pairedDashboard = active && Number.isInteger(active.splitViewId) && active.splitViewId >= 0 &&
        tabs.find(tab => tab.splitViewId === active.splitViewId && isDashboard(tab));
      if (pairedDashboard) {
        const state = await dashboardState(pairedDashboard);
        await api.tabs.update(pairedDashboard.id, { active: true });
        return sendToDashboard(state, 'remote:show', { state });
      }
      const previous = await getState(windowId);
      let dashboard = isDashboard(active) ? active : tabs.find(tab =>
        tab.id === previous?.dashboardTabId && isDashboard(tab));
      const sourceTabId = active && !isDashboard(active)
        ? active.id : previous?.sourceTabId ?? null;
      const state = {
        enabled: true, windowId, dashboardTabId: dashboard?.id ?? null, sourceTabId,
        selectedTabId: active && !isDashboard(active) ? active.id : previous?.selectedTabId ?? sourceTabId,
      };
      await saveState(windowId, state);
      if (!dashboard) {
        dashboard = await api.tabs.create({ windowId, url: `${dashboardUrl}?remote=1`, active: true });
        state.dashboardTabId = dashboard.id;
        await saveState(windowId, state);
      } else {
        await api.tabs.update(dashboard.id, { active: true });
      }
      await sendToDashboard(state, 'remote:show', { state });
    }

    async function handleMessage(message, sender) {
      if (sender?.id !== api.runtime.id || !Number.isInteger(sender.tab?.id) ||
          (sender.url || sender.tab.url || '').split(/[?#]/)[0] !== dashboardUrl) return;
      const state = await getState(sender.tab.windowId);
      if (message.type === 'remote:get-state') {
        const read = async () => ({ ok: true, state: await dashboardState(await api.tabs.get(sender.tab.id)) });
        // A newly created page must finish initialization before it can acknowledge remote:show.
        return showingDashboard ? read() : enqueue(read);
      }
      if (message.type === 'remote:activate' && Number.isInteger(message.tabId)) {
        return enqueue(async () => {
          const tab = await api.tabs.get(sender.tab.id);
          const current = await dashboardState(tab);
          if (!current?.enabled) return { ok: false, error: '请先按菜单进入标签总览。' };
          current.selectedTabId = message.tabId;
          await saveState(current.windowId, current);
          await finishSelection(current, message.tabId, '选中标签已关闭，请重新选择。');
          return { ok: true };
        });
      }
      if (message.type === 'remote:selection') {
        if (!state?.enabled || state.dashboardTabId !== sender.tab.id ||
            !Number.isInteger(message.selectedTabId)) return { ok: false };
        try {
          const target = await api.tabs.get(message.selectedTabId);
          if (isDashboard(target)) return { ok: false };
          state.selectedTabId = target.id;
          await saveState(state.windowId, state);
          return { ok: true };
        } catch {
          state.selectedTabId = null;
          await saveState(state.windowId, state);
          return { ok: false, error: '选中标签已关闭，请重新选择。' };
        }
      }
      if (message.type === 'remote:execute' && commands.has(message.command)) {
        await handleCommand(message.command, sender.tab);
        return { ok: true };
      }
    }

    async function finishSelection(state, tabId, missingMessage) {
      let target;
      try {
        target = await api.tabs.get(tabId);
        if (isDashboard(target)) throw new Error('Dashboard cannot be a navigation target');
      } catch {
        await sendToDashboard(state, 'remote:error', { text: missingMessage });
        return;
      }
      try {
        const result = await split.select(state.dashboardTabId, target.id);
        if (result.handled) {
          const next = await dashboardState(await api.tabs.get(state.dashboardTabId));
          await sendToDashboard(next, 'remote:show', { state: next, focusDashboard: false });
          return restoreMuseInput(next, target.id);
        }
        await api.tabs.update(target.id, { active: true });
        await api.windows.update(target.windowId, { focused: true });
      } catch (error) {
        await sendToDashboard(state, 'remote:error', { text: error.message || '目标标签或窗口已变化，请重新选择。' });
        return;
      }
      state.enabled = false;
      await saveState(state.windowId, state);
      try {
        await api.runtime.sendMessage({ type: 'remote:end', targetTabId: state.dashboardTabId });
      } catch { /* The target was activated even if its old dashboard closed. */ }
    }

    async function restoreMuseInput(state, tabId) {
      const result = await muse.restore(tabId);
      if (['missing', 'ambiguous', 'unavailable'].includes(result.status)) {
        await sendToDashboard(state, 'remote:error', { text: '已切换到 Muse，但无法定位唯一可编辑的消息框，请手动点击输入框。' });
      }
    }

    async function processCommand(command, triggeringTab) {
      if (!commands.has(command)) return;
      const windowId = triggeringTab?.windowId ?? (await api.windows.getLastFocused()).id;
      const tabs = await api.tabs.query({ windowId });
      if (command === 'show-dashboard') {
        showingDashboard = true;
        try { return await showDashboard(windowId, tabs); }
        finally { showingDashboard = false; }
      }
      const active = tabs.find(tab => tab.id === triggeringTab?.id && tab.active) || tabs.find(tab => tab.active);
      if (!active) return;
      const pairedDashboard = Number.isInteger(active.splitViewId) && active.splitViewId >= 0 &&
        tabs.find(tab => tab.splitViewId === active.splitViewId && isDashboard(tab));
      if (isDashboard(active) || pairedDashboard) {
        const dashboard = pairedDashboard || active;
        const state = await dashboardState(dashboard);
        if (!state?.enabled || state.dashboardTabId !== dashboard.id) return;
        if (command === 'confirm-selection') {
          return finishSelection(state, state.selectedTabId, '选中标签已关闭，请重新选择。');
        }
        if (command === 'cancel-selection') {
          try {
            const result = await split.cancel(dashboard.id);
            if (result.handled) {
              const next = await dashboardState(await api.tabs.get(dashboard.id));
              await sendToDashboard(next, 'remote:show', { state: next, focusDashboard: false });
              const context = await split.inspect(dashboard.id);
              if (context) await restoreMuseInput(next, context.partner.id);
              return;
            }
          } catch (error) {
            return sendToDashboard(state, 'remote:error', { text: error.message });
          }
          return finishSelection(state, state.sourceTabId, '来源标签已关闭，请在总览中选择其他标签。');
        }
        return sendToDashboard(state, 'remote:action', { command });
      }
      if (!['navigate-left', 'navigate-right'].includes(command)) return;
      const targets = tabs.filter(tab => !isDashboard(tab)).sort((a, b) => a.index - b.index);
      const index = targets.findIndex(tab => tab.id === active.id);
      if (index < 0 || targets.length < 2) return;
      const offset = command === 'navigate-left' ? -1 : 1;
      const target = targets[(index + offset + targets.length) % targets.length];
      await api.tabs.update(target.id, { active: true });
    }

    function enqueue(task) {
      const result = commandQueue.then(task);
      commandQueue = result.catch(() => {});
      return result;
    }

    function handleCommand(command, triggeringTab) {
      return enqueue(() => processCommand(command, triggeringTab));
    }

    return { handleCommand, handleMessage };
  }

  const exported = { createRemoteController };
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  else root.TabOutRemoteBackground = exported;
})(globalThis);
