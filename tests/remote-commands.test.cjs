const test = require('node:test');
const assert = require('node:assert/strict');
const { createRemoteController } = require('../extension/remote-background.js');
const { createChromeFixture, dashboardUrl } = require('./chrome-fixture.cjs');

test('左右按当前窗口标签栏顺序循环，跳过总览且不跨窗口', async () => {
  const browser = createChromeFixture([
    { id: 3, windowId: 1, index: 2, url: 'https://c.example', active: false },
    { id: 9, windowId: 2, index: 0, url: 'https://other.example', active: true },
    { id: 1, windowId: 1, index: 0, url: 'https://a.example', active: true },
    { id: 4, windowId: 1, index: 3, url: `${dashboardUrl}?remote=1`, active: false },
    { id: 2, windowId: 1, index: 1, url: 'https://b.example', active: false },
  ]);
  browser.focus(1);
  const controller = createRemoteController(browser.api);
  const visited = [];
  for (let i = 0; i < 3; i++) {
    await controller.handleCommand('navigate-right');
    visited.push(browser.active(1));
  }
  await controller.handleCommand('navigate-left');
  visited.push(browser.active(1));
  assert.deepEqual(visited, [2, 3, 1, 3]);
  assert.equal(browser.active(2), 9);
});

test('激活过程中目标被关闭，保留可继续操作的总览', async () => {
  const browser = createChromeFixture([
    { id: 1, windowId: 1, index: 0, url: 'https://a.example', active: true },
    { id: 2, windowId: 1, index: 1, url: 'https://b.example', active: false },
  ]);
  const controller = createRemoteController(browser.api);
  await controller.handleCommand('show-dashboard');
  const dashboard = browser.allTabs().find(tab => tab.url.startsWith(dashboardUrl));
  const sender = { id: browser.api.runtime.id, tab: dashboard, url: dashboard.url };
  await controller.handleMessage({ type: 'remote:selection', selectedTabId: 2 }, sender);
  const update = browser.api.tabs.update;
  browser.api.tabs.update = async (id, data) => {
    if (id === 2) throw new Error('No tab with id');
    return update(id, data);
  };
  await controller.handleCommand('confirm-selection');
  assert.equal(browser.active(1), dashboard.id);
  assert.equal((await controller.handleMessage({ type: 'remote:get-state' }, sender)).state.enabled, true);
});

test('移动选择时目标刚被关闭，确定不会误激活上一次选中的标签', async () => {
  const browser = createChromeFixture([
    { id: 1, windowId: 1, index: 0, url: 'https://a.example', active: true },
    { id: 2, windowId: 1, index: 1, url: 'https://b.example', active: false },
  ]);
  const controller = createRemoteController(browser.api);
  await controller.handleCommand('show-dashboard');
  const dashboard = browser.allTabs().find(tab => tab.url.startsWith(dashboardUrl));
  browser.remove(2);
  await controller.handleMessage({ type: 'remote:selection', selectedTabId: 2 }, {
    id: browser.api.runtime.id, tab: dashboard, url: dashboard.url,
  });
  await controller.handleCommand('confirm-selection');
  assert.equal(browser.active(1), dashboard.id);
  assert.match(browser.messages.at(-1).text, /选中标签已关闭/);
});

test('返回恢复来源标签；来源关闭时保留总览并说明原因', async () => {
  for (const closeSource of [false, true]) {
    const browser = createChromeFixture([
      { id: 1, windowId: 1, index: 0, url: 'https://a.example', active: true },
    ]);
    const controller = createRemoteController(browser.api);
    await controller.handleCommand('show-dashboard');
    const dashboard = browser.allTabs().find(tab => tab.url.startsWith(dashboardUrl));
    if (closeSource) browser.remove(1);
    await controller.handleCommand('cancel-selection');
    assert.equal(browser.active(1), closeSource ? dashboard.id : 1);
    if (closeSource) assert.match(browser.messages.at(-1).text, /来源标签已关闭/);
  }
});

test('独立窗口的方向命令只送到当前总览，不广播执行其他窗口', async () => {
  const browser = createChromeFixture([
    { id: 1, windowId: 1, index: 0, url: 'https://a.example', active: true },
    { id: 2, windowId: 2, index: 0, url: 'https://b.example', active: true },
  ]);
  const controller = createRemoteController(browser.api);
  browser.focus(1);
  await controller.handleCommand('show-dashboard');
  browser.focus(2);
  await controller.handleCommand('show-dashboard');
  const dashboard2 = browser.allTabs().find(tab => tab.windowId === 2 && tab.url.startsWith(dashboardUrl));
  await controller.handleCommand('navigate-down');
  assert.equal(browser.messages.at(-1).targetTabId, dashboard2.id);
  assert.equal(browser.messages.at(-1).command, 'navigate-down');
});

test('网页或其他扩展不能伪造总览选择状态', async () => {
  const browser = createChromeFixture([
    { id: 1, windowId: 1, index: 0, url: 'https://a.example', active: true },
    { id: 2, windowId: 1, index: 1, url: 'https://b.example', active: false },
  ]);
  const controller = createRemoteController(browser.api);
  await controller.handleCommand('show-dashboard');
  const dashboard = browser.allTabs().find(tab => tab.url.startsWith(dashboardUrl));
  await controller.handleMessage({ type: 'remote:selection', selectedTabId: 2 }, {
    id: 'other-extension', tab: dashboard, url: dashboard.url,
  });
  await controller.handleCommand('confirm-selection');
  assert.equal(browser.active(1), 1);
});

test('确定按真实标签身份激活跨窗口的重复网址，而不是按 URL 猜测', async () => {
  const browser = createChromeFixture([
    { id: 1, windowId: 1, index: 0, url: 'https://same.example', active: true },
    { id: 2, windowId: 2, index: 0, url: 'https://same.example', active: false },
    { id: 3, windowId: 2, index: 1, url: 'https://other.example', active: true },
  ]);
  browser.focus(1);
  const controller = createRemoteController(browser.api);
  await controller.handleCommand('show-dashboard');
  const dashboard = browser.allTabs().find(tab => tab.url.startsWith(dashboardUrl));
  const sender = { id: browser.api.runtime.id, tab: dashboard, url: dashboard.url };
  await controller.handleMessage({ type: 'remote:selection', selectedTabId: 2 }, sender);
  await controller.handleCommand('confirm-selection');
  assert.equal(browser.active(2), 2);
  assert.equal((await browser.api.windows.getLastFocused()).id, 2);
  const state = await controller.handleMessage({ type: 'remote:get-state' }, sender);
  assert.equal(state.state.enabled, false);
});

test('连续快速点按每次前进一步，不因异步激活而丢步', async () => {
  const browser = createChromeFixture([
    { id: 1, windowId: 1, index: 0, url: 'https://a.example', active: true },
    { id: 2, windowId: 1, index: 1, url: 'https://b.example', active: false },
    { id: 3, windowId: 1, index: 2, url: 'https://c.example', active: false },
    { id: 4, windowId: 1, index: 3, url: 'https://d.example', active: false },
  ]);
  const controller = createRemoteController(browser.api);
  await Promise.all(Array.from({ length: 6 }, () => controller.handleCommand('navigate-right')));
  assert.equal(browser.active(1), 3);
});

test('菜单每窗口重用总览，重复呼出保留选择，后台恢复后仍保留来源', async () => {
  const browser = createChromeFixture([
    { id: 1, windowId: 1, index: 0, url: 'https://a.example', active: true },
    { id: 2, windowId: 1, index: 1, url: 'https://b.example', active: false },
  ]);
  const controller = createRemoteController(browser.api);
  await controller.handleCommand('show-dashboard');
  const dashboard = browser.allTabs().find(tab => tab.url.startsWith(dashboardUrl));
  assert.ok(dashboard);
  const sender = { id: browser.api.runtime.id, tab: dashboard, url: dashboard.url };
  const initial = await controller.handleMessage({ type: 'remote:get-state' }, sender);
  assert.equal(initial.state.sourceTabId, 1);
  assert.equal(initial.state.selectedTabId, 1);
  await controller.handleMessage({ type: 'remote:selection', selectedTabId: 2 }, sender);
  const restored = createRemoteController(browser.api);
  await restored.handleCommand('show-dashboard');
  const state = await restored.handleMessage({ type: 'remote:get-state' }, sender);
  assert.equal(state.state.selectedTabId, 2);
  assert.equal(state.state.sourceTabId, 1);
  assert.equal(browser.allTabs().filter(tab => tab.url.startsWith(dashboardUrl)).length, 1);
});
