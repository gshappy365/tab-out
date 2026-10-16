(function (root) {
  'use strict';

  function createRemoteDashboard({ api, document, render, notify }) {
    let state = { enabled: false, selectedTabId: null };
    let selectionIndex = 0;
    let ownTab;
    let ready = Promise.resolve();
    let refreshTimer;
    let lastError = '';
    const identity = api.tabs.getCurrent().then(tab => { ownTab = tab; return tab; });
    const targets = () => Array.from(document.querySelectorAll('.remote-target'));

    function applyState(next) {
      state = next ? { ...next } : { enabled: false, selectedTabId: null };
      document.body.classList.toggle('remote-mode', !!state.enabled);
      document.body.classList.toggle('split-mode', !!state.split);
      document.getElementById('remoteHelp').hidden = !state.enabled;
      document.getElementById('remoteStatus').textContent = lastError || (state.split
        ? '分屏选择 · 确定更换浏览侧 · 返回恢复起始标签'
        : '方向键选择 · 确定进入 · 返回原标签');
    }

    async function choose(tabId, scroll = true) {
      const elements = targets();
      const selected = elements.find(element => Number(element.dataset.tabId) === tabId);
      if (!selected) return;
      const changed = state.selectedTabId !== tabId;
      state.selectedTabId = tabId;
      selectionIndex = elements.indexOf(selected);
      for (const element of elements) {
        const active = element === selected;
        element.classList.toggle('remote-selected', active);
        element.setAttribute('aria-selected', String(active));
        element.tabIndex = active ? 0 : -1;
      }
      if (scroll) selected.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      if (changed) {
        const response = await api.runtime.sendMessage({ type: 'remote:selection', selectedTabId: tabId });
        if (!response?.ok) {
          state.selectedTabId = null;
          notify(response?.error || '选择未保存，请刷新总览。');
          scheduleRefresh();
        }
      }
    }

    async function reconcile() {
      if (!state.enabled) return;
      const elements = targets();
      if (!elements.length) {
        document.getElementById('remoteStatus').textContent = '没有可选择的标签，请先打开一个网页。';
        return;
      }
      const selected = elements.find(element => Number(element.dataset.tabId) === state.selectedTabId)
        || elements[Math.min(selectionIndex, elements.length - 1)];
      await choose(Number(selected.dataset.tabId));
    }

    async function move(command) {
      const candidates = targets().map(element => {
        const rect = element.getBoundingClientRect();
        return { id: Number(element.dataset.tabId), left: rect.left, top: rect.top, width: rect.width, height: rect.height };
      }).filter(target => target.width > 0 && target.height > 0);
      const nextId = TabOutSpatial.chooseSpatialTarget(candidates, state.selectedTabId, command.replace('navigate-', ''));
      if (nextId !== null) await choose(nextId);
    }

    async function execute(command) {
      await ready;
      const response = await api.runtime.sendMessage({ type: 'remote:execute', command });
      if (response?.error) notify(response.error);
    }

    async function activate(tabId) {
      await ready;
      await choose(tabId, false);
      const response = await api.runtime.sendMessage({ type: 'remote:activate', tabId });
      if (response?.error) notify(response.error);
    }

    api.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (sender.id !== api.runtime.id || sender.tab ||
          !['remote:show', 'remote:action', 'remote:error', 'remote:end'].includes(message?.type)) return false;
      if (ownTab && message.targetTabId !== ownTab.id) return false;
      (async () => {
        const tab = await identity;
        if (message.targetTabId !== tab.id) return;
        await ready;
        if (message.type === 'remote:show') {
          lastError = '';
          applyState(message.state);
          await showBindings();
          await render();
          if (state.split && message.focusDashboard !== false) root.focus();
        } else if (message.type === 'remote:action' && state.enabled) {
          await move(message.command);
        } else if (message.type === 'remote:error') {
          lastError = message.text;
          await render();
          document.getElementById('remoteStatus').textContent = message.text;
          notify(message.text);
        } else if (message.type === 'remote:end') {
          applyState(null);
          await render();
        }
        sendResponse({ ok: true, selectedTabId: state.selectedTabId });
      })().catch(error => sendResponse({ ok: false, error: error.message }));
      return true;
    });

    function scheduleRefresh() {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(async () => {
        try {
          await ready;
          const response = await api.runtime.sendMessage({ type: 'remote:get-state' });
          applyState(response?.state);
          await render();
        } catch (error) { notify(error.message); }
      }, 80);
    }

    for (const event of [api.tabs.onCreated, api.tabs.onRemoved, api.tabs.onUpdated, api.tabs.onMoved, api.tabs.onAttached, api.tabs.onDetached, api.tabs.onActivated]) {
      event.addListener(scheduleRefresh);
    }
    root.addEventListener('resize', scheduleRefresh);
    document.addEventListener('visibilitychange', async () => {
      if (document.visibilityState !== 'visible') return;
      await ready;
      try {
        const response = await api.runtime.sendMessage({ type: 'remote:get-state' });
        applyState(response?.state);
        await showBindings();
        await render();
      } catch (error) { notify(error.message); }
    });

    document.addEventListener('keydown', event => {
      if (!state.enabled || event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
      const command = { ArrowLeft: 'navigate-left', ArrowRight: 'navigate-right', ArrowUp: 'navigate-up',
        ArrowDown: 'navigate-down', Enter: 'confirm-selection', Escape: 'cancel-selection' }[event.key];
      if (!command || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      event.preventDefault();
      execute(command).catch(error => notify(error.message));
    });

    async function showBindings() {
      const commands = await api.commands.getAll();
      const order = ['show-dashboard', 'navigate-left', 'navigate-right', 'confirm-selection',
        'navigate-up', 'navigate-down', 'cancel-selection'];
      const missing = order.map(name => commands.find(command => command.name === name))
        .filter(command => command && !command.shortcut).map(command => command.description.split('：')[0]);
      document.getElementById('remoteBindings').textContent = missing.length
        ? `首次使用请设置：${missing.join('、')} 的快捷键。` : '七个遥控快捷键均已绑定。';
    }

    function start() {
      ready = (async () => {
        await identity;
        const response = await api.runtime.sendMessage({ type: 'remote:get-state' });
        applyState(response?.state);
        await showBindings();
        await render();
      })();
      return ready;
    }

    return { get enabled() { return !!state.enabled; }, start, reconcile, activate, execute };
  }

  root.TabOutRemoteDashboard = { createRemoteDashboard };
})(globalThis);
