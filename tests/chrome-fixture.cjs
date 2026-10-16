const dashboardUrl = 'chrome-extension://test-extension/index.html';

function createChromeFixture(initialTabs) {
  let tabs = structuredClone(initialTabs).map(tab => ({ splitViewId: -1, pinned: false, groupId: -1, incognito: false, ...tab }));
  let focusedWindow = tabs.find(tab => tab.active)?.windowId ?? 1;
  let nextId = 100;
  let nextSplitId = 1000;
  const session = {};
  const messages = [];
  const api = {
    runtime: {
      id: 'test-extension',
      getURL: path => `chrome-extension://test-extension/${path}`,
      sendMessage: async message => {
        messages.push(structuredClone(message));
        return { ok: true, selectedTabId: message.state?.selectedTabId };
      },
    },
    storage: { session: {
      get: async key => key === null ? structuredClone(session) : ({ [key]: structuredClone(session[key]) }),
      set: async values => Object.assign(session, structuredClone(values)),
    } },
    windows: {
      get: async id => { if (!tabs.some(tab => tab.windowId === id)) throw new Error('No window'); return { id, type: 'normal' }; },
      getLastFocused: async () => ({ id: focusedWindow, type: 'normal' }),
      update: async id => { focusedWindow = id; return { id }; },
    },
    tabs: {
      query: async query => structuredClone(tabs.filter(tab =>
        (query.windowId === undefined || tab.windowId === query.windowId) &&
        (query.splitViewId === undefined || tab.splitViewId === query.splitViewId) &&
        (!query.lastFocusedWindow || tab.windowId === focusedWindow) &&
        (!query.active || tab.active))),
      get: async id => {
        const tab = tabs.find(item => item.id === id);
        if (!tab) throw new Error('No tab with id');
        return structuredClone(tab);
      },
      update: async (id, update) => {
        await new Promise(resolve => setTimeout(resolve, 2));
        const target = tabs.find(tab => tab.id === id);
        if (!target) throw new Error('No tab with id');
        if (update.active) {
          for (const tab of tabs) if (tab.windowId === target.windowId) tab.active = false;
        }
        Object.assign(target, update);
        return structuredClone(target);
      },
      create: async options => {
        if (options.active) for (const tab of tabs) {
          if (tab.windowId === options.windowId) tab.active = false;
        }
        const tab = { id: nextId++, index: tabs.filter(t => t.windowId === options.windowId).length, ...options };
        tabs.push(tab);
        return structuredClone(tab);
      },
      move: async (id, options) => {
        const tab = tabs.find(t => t.id === id);
        if (!tab) throw new Error('No tab with id');
        const oldWindow = tab.windowId;
        const destination = options.windowId ?? oldWindow;
        const remainder = tabs.filter(t => t.id !== id);
        const ordered = remainder.filter(t => t.windowId === destination).sort((a, b) => a.index - b.index);
        ordered.splice(options.index < 0 ? ordered.length : options.index, 0, tab);
        tab.windowId = destination;
        ordered.forEach((t, index) => { t.index = index; });
        remainder.filter(t => t.windowId === oldWindow && oldWindow !== destination)
          .sort((a, b) => a.index - b.index).forEach((t, index) => { t.index = index; });
        return structuredClone(tab);
      },
      createSplit: async ids => {
        const pair = ids.map(id => tabs.find(t => t.id === id));
        if (pair.some(t => !t || t.splitViewId >= 0) || Math.abs(pair[0].index - pair[1].index) !== 1 ||
            ['windowId', 'pinned', 'groupId'].some(key => pair[0][key] !== pair[1][key])) throw new Error('Incompatible tabs');
        const id = nextSplitId++;
        pair.forEach(t => { t.splitViewId = id; });
        return id;
      },
      unsplit: async id => {
        if (!tabs.some(t => t.splitViewId === id)) throw new Error('No split');
        tabs.filter(t => t.splitViewId === id).forEach(t => { t.splitViewId = -1; });
      },
    },
  };
  return {
    api, messages,
    active: windowId => tabs.find(tab => tab.windowId === windowId && tab.active)?.id,
    allTabs: () => structuredClone(tabs),
    remove: id => { tabs = tabs.filter(tab => tab.id !== id); },
    focus: id => { focusedWindow = id; },
  };
}

module.exports = { createChromeFixture, dashboardUrl };
