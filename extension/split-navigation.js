(function (root) {
  'use strict';

  function createSplitNavigator(api) {
    const key = id => `split.dashboard.${id}`;
    const hasSplit = tab => Number.isInteger(tab?.splitViewId) && tab.splitViewId >= 0;
    const store = (id, value) => api.storage.session.set({ [key(id)]: value });

    async function inspect(dashboardId) {
      let dashboard;
      try { dashboard = await api.tabs.get(dashboardId); } catch { return null; }
      const saved = (await api.storage.session.get(key(dashboardId)))[key(dashboardId)];
      const pair = hasSplit(dashboard)
        ? (await api.tabs.query({ windowId: dashboard.windowId })).filter(tab => tab.splitViewId === dashboard.splitViewId)
        : [];
      const partner = pair.length === 2 && pair.find(tab => tab.id !== dashboardId);
      const session = partner && saved?.splitViewId === dashboard.splitViewId &&
        saved.partnerTabId === partner.id && saved.windowId === dashboard.windowId ? saved : null;
      if (saved && !session) await store(dashboardId, null);
      return partner ? { dashboard, partner, session } : null;
    }

    function requireSupport() {
      if (typeof api.tabs.createSplit !== 'function' || typeof api.tabs.unsplit !== 'function') {
        throw new Error('此 Chrome 暂不支持重组分屏，请使用 Chrome 155 或更新版本。');
      }
    }

    async function focus(dashboard) {
      await api.tabs.update(dashboard.id, { active: true });
      await api.windows.update(dashboard.windowId, { focused: true });
    }

    async function join(dashboardId, targetId, dashboardLeft) {
      const dashboard = await api.tabs.get(dashboardId);
      const target = await api.tabs.get(targetId);
      const index = dashboard.index + (dashboardLeft ? 1 : 0) -
        (target.windowId === dashboard.windowId && target.index < dashboard.index ? 1 : 0);
      await api.tabs.move(targetId, { windowId: dashboard.windowId, index });
      const splitViewId = await api.tabs.createSplit(dashboardLeft ? [dashboardId, targetId] : [targetId, dashboardId]);
      return splitViewId;
    }

    async function replace(context, targetId, returning = false) {
      const { dashboard, partner, session } = context;
      const target = await api.tabs.get(targetId);
      if (target.id === partner.id) {
        await focus(dashboard);
        if (returning) await store(dashboard.id, null);
        return { handled: true, originalTabId: returning ? null : session?.originalTabId ?? null };
      }
      requireSupport();
      if (target.id === dashboard.id || target.incognito !== dashboard.incognito) {
        throw new Error('不能把总览自身或其他浏览上下文的标签配到浏览侧。');
      }
      if (!!target.pinned !== !!dashboard.pinned || (target.groupId ?? -1) !== (dashboard.groupId ?? -1)) {
        throw new Error('目标的固定状态或 Chrome 标签组与总览不兼容，未改变分屏。');
      }
      const [currentWindow, targetWindow] = await Promise.all([
        api.windows.get(dashboard.windowId), api.windows.get(target.windowId),
      ]);
      if (currentWindow.type !== 'normal' || targetWindow.type !== 'normal') {
        throw new Error('此窗口类型不支持移动标签并重组分屏。');
      }
      const targetPair = hasSplit(target)
        ? (await api.tabs.query({ windowId: target.windowId })).filter(tab => tab.splitViewId === target.splitViewId)
        : [];
      const dashboardLeft = dashboard.index < partner.index;
      const snapshots = [dashboard, partner, target, ...targetPair]
        .filter((tab, index, all) => all.findIndex(t => t.id === tab.id) === index);
      try {
        await api.tabs.unsplit(dashboard.splitViewId);
        if (hasSplit(target)) await api.tabs.unsplit(target.splitViewId);
        const splitViewId = await join(dashboard.id, target.id, dashboardLeft);
        await focus(dashboard);
        await store(dashboard.id, returning ? null : {
          splitViewId, windowId: dashboard.windowId, partnerTabId: target.id,
          originalTabId: session?.originalTabId ?? partner.id,
        });
        return { handled: true, originalTabId: returning ? null : session?.originalTabId ?? partner.id };
      } catch (error) {
        let restored = false;
        try {
          // Browser operations are not atomic. Restore surviving tabs without closing or reloading them.
          const splitIds = new Set();
          for (const tab of snapshots) {
            try { const current = await api.tabs.get(tab.id); if (hasSplit(current)) splitIds.add(current.splitViewId); } catch {}
          }
          for (const id of splitIds) await api.tabs.unsplit(id);
          for (const tab of [...snapshots].sort((a, b) => a.windowId - b.windowId || a.index - b.index)) {
            await api.tabs.move(tab.id, { windowId: tab.windowId, index: tab.index });
          }
          const restoredSplit = await api.tabs.createSplit([dashboard.id, partner.id]);
          if (targetPair.length === 2) await api.tabs.createSplit(targetPair.map(tab => tab.id));
          await focus(dashboard);
          await store(dashboard.id, session ? { ...session, splitViewId: restoredSplit } : null);
          restored = true;
        } catch {
          await store(dashboard.id, null);
        }
        throw new Error(restored ? '分屏切换失败，已恢复原组合，请重试。' :
          '分屏切换失败，无法完整恢复原布局；已保留仍存在的标签，请检查分屏后重试。', { cause: error });
      }
    }

    async function select(dashboardId, targetId) {
      const context = await inspect(dashboardId);
      return context ? replace(context, targetId) : { handled: false };
    }

    async function cancel(dashboardId) {
      const context = await inspect(dashboardId);
      if (!context) return { handled: false };
      if (!context.session) throw new Error('本次尚未更换浏览侧，无需恢复。');
      try { await api.tabs.get(context.session.originalTabId); } catch {
        await store(dashboardId, null);
        throw new Error('起始浏览标签已关闭，无法恢复；已保留当前分屏。');
      }
      return replace(context, context.session.originalTabId, true);
    }

    return { inspect, select, cancel };
  }

  const exported = { createSplitNavigator };
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  else root.TabOutSplit = exported;
})(globalThis);
