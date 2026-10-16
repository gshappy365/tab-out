const dashboardUrl = 'chrome-extension://test-extension/index.html';

function createChromeFixture(initialTabs) {
  let tabs = structuredClone(initialTabs);
  let focusedWindow = tabs.find(tab => tab.active)?.windowId ?? 1;
  let nextId = 100;
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
      get: async key => ({ [key]: structuredClone(session[key]) }),
      set: async values => Object.assign(session, structuredClone(values)),
    } },
    windows: {
      getLastFocused: async () => ({ id: focusedWindow, type: 'normal' }),
      update: async id => { focusedWindow = id; return { id }; },
    },
    tabs: {
      query: async query => structuredClone(tabs.filter(tab =>
        (query.windowId === undefined || tab.windowId === query.windowId) &&
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
