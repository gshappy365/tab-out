const test = require('node:test');
const assert = require('node:assert/strict');
const { createRemoteController } = require('../extension/remote-background.js');
const { createChromeFixture, dashboardUrl } = require('./chrome-fixture.cjs');

const dashboard = { id: 10, windowId: 1, index: 0, url: dashboardUrl, active: true, splitViewId: 5 };
const original = { id: 11, windowId: 1, index: 1, url: 'https://example.test/a', splitViewId: 5 };
const target = { id: 12, windowId: 1, index: 2, url: 'https://example.test/b' };
const sender = { id: 'test-extension', tab: dashboard, url: dashboardUrl };

test('已有分屏：点击准确标签替换浏览侧，总览保留且原标签未关闭', async () => {
  const f = createChromeFixture([dashboard, original, target]);
  const controller = createRemoteController(f.api);
  const response = await controller.handleMessage({ type: 'remote:activate', tabId: target.id }, sender);
  assert.equal(response?.ok, true);
  const [d, a, b] = await Promise.all([10, 11, 12].map(id => f.api.tabs.get(id)));
  assert.equal(d.splitViewId, b.splitViewId);
  assert.ok(d.splitViewId >= 0);
  assert.equal(a.splitViewId, -1);
  assert.equal(f.active(1), 12);
  assert.equal(b.url, target.url);
  assert.equal(f.messages.at(-1).focusDashboard, false);
  assert.equal(f.messages.some(message => message.type === 'remote:end'), false);
});

test('连续选择和重复菜单不覆盖起点，返回成功后下一次重新记录', async () => {
  const f = createChromeFixture([dashboard, original, target, { ...target, id: 13, index: 3 }]);
  let controller = createRemoteController(f.api);
  const choose = id => controller.handleMessage({ type: 'remote:activate', tabId: id }, sender);
  await choose(12);
  await controller.handleCommand('show-dashboard');
  controller = createRemoteController(f.api); // Service worker restart retains the return destination.
  await choose(13);
  assert.equal((await controller.handleMessage({ type: 'remote:get-state' }, sender)).state.originalTabId, 11);
  await controller.handleCommand('cancel-selection');
  assert.equal((await f.api.tabs.get(10)).splitViewId, (await f.api.tabs.get(11)).splitViewId);
  assert.equal((await controller.handleMessage({ type: 'remote:get-state' }, sender)).state.originalTabId, null);
  await choose(12);
  assert.equal((await controller.handleMessage({ type: 'remote:get-state' }, sender)).state.originalTabId, 11);
});

test('跨窗口取出另一个分屏中的真实标签，原伙伴保留', async () => {
  const f = createChromeFixture([dashboard, original,
    { ...target, windowId: 2, index: 0, splitViewId: 7 },
    { id: 20, windowId: 2, index: 1, splitViewId: 7, url: 'https://example.test/c' }]);
  const controller = createRemoteController(f.api);
  await controller.handleMessage({ type: 'remote:activate', tabId: 12 }, sender);
  const d = await f.api.tabs.get(10), b = await f.api.tabs.get(12), c = await f.api.tabs.get(20);
  assert.equal(b.windowId, 1);
  assert.equal(b.splitViewId, d.splitViewId);
  assert.equal(c.windowId, 2);
  assert.equal(c.splitViewId, -1);
  assert.equal(f.active(1), 12);
  assert.equal((await f.api.windows.getLastFocused()).id, 1);
});

test('总览原在右侧，替换后仍在右侧；目标原在总览之前也保持顺序', async () => {
  for (const dashboardLeft of [false, true]) {
    const f = createChromeFixture([{ ...target, index: 0 },
      { ...dashboard, index: dashboardLeft ? 1 : 2 }, { ...original, index: dashboardLeft ? 2 : 1 }]);
    await createRemoteController(f.api).handleMessage({ type: 'remote:activate', tabId: 12 }, sender);
    assert.equal((await f.api.tabs.get(10)).index < (await f.api.tabs.get(12)).index, dashboardLeft);
  }
});

test('浏览侧有焦点时遥控方向仍发送给总览，确定不会切走整个组合', async () => {
  const f = createChromeFixture([{ ...dashboard, active: false }, { ...original, active: true }, target]);
  const controller = createRemoteController(f.api);
  await controller.handleCommand('navigate-right', original);
  assert.equal(f.messages.at(-1).targetTabId, 10);
  assert.equal(f.messages.at(-1).type, 'remote:action');
  assert.equal(f.active(1), 11);
  await controller.handleMessage({ type: 'remote:selection', selectedTabId: 12 }, sender);
  await controller.handleCommand('confirm-selection', original);
  assert.equal((await f.api.tabs.get(12)).splitViewId, (await f.api.tabs.get(10)).splitViewId);
  assert.equal(f.active(1), 12);
});

test('固定、标签组、隐私上下文不兼容时提示且没有结构变更', async () => {
  for (const incompatible of [{ pinned: true }, { groupId: 8 }, { incognito: true }]) {
    const f = createChromeFixture([dashboard, original, { ...target, ...incompatible }]);
    const before = f.allTabs();
    await createRemoteController(f.api).handleMessage({ type: 'remote:activate', tabId: 12 }, sender);
    assert.deepEqual(f.allTabs(), before);
    assert.equal(f.messages.at(-1).type, 'remote:error');
  }
});

test('手动更换伙伴后放弃旧返回记录，新的选择使用新起点', async () => {
  const f = createChromeFixture([dashboard, original, target, { ...target, id: 13, index: 3 }]);
  const controller = createRemoteController(f.api);
  await controller.handleMessage({ type: 'remote:activate', tabId: 12 }, sender);
  await f.api.tabs.unsplit((await f.api.tabs.get(10)).splitViewId);
  await f.api.tabs.move(13, { index: 1 });
  await f.api.tabs.createSplit([10, 13]);
  await f.api.tabs.update(10, { active: true });
  await controller.handleCommand('cancel-selection');
  assert.match(f.messages.at(-1).text, /尚未更换/);
  await controller.handleMessage({ type: 'remote:activate', tabId: 12 }, sender);
  assert.equal((await controller.handleMessage({ type: 'remote:get-state' }, sender)).state.originalTabId, 13);
});

test('起始标签关闭时保留当前分屏并说明无法恢复', async () => {
  const f = createChromeFixture([dashboard, original, target]);
  const controller = createRemoteController(f.api);
  await controller.handleMessage({ type: 'remote:activate', tabId: 12 }, sender);
  f.remove(11);
  const current = (await f.api.tabs.get(10)).splitViewId;
  await controller.handleCommand('cancel-selection');
  assert.match(f.messages.at(-1).text, /起始浏览标签已关闭/);
  assert.equal((await f.api.tabs.get(10)).splitViewId, current);
});

test('浏览器不支持分屏重组时保持现状，不降级为 URL 导航', async () => {
  const f = createChromeFixture([dashboard, original, target]);
  delete f.api.tabs.createSplit;
  const before = f.allTabs();
  await createRemoteController(f.api).handleMessage({ type: 'remote:activate', tabId: 12 }, sender);
  assert.match(f.messages.at(-1).text, /Chrome 155/);
  assert.deepEqual(f.allTabs(), before);
});

test('重组失败时恢复旧组合，连续点击串行完成，不丢失标签', async () => {
  const f = createChromeFixture([dashboard, original, target, { ...target, id: 13, index: 3 }]);
  const controller = createRemoteController(f.api);
  const create = f.api.tabs.createSplit;
  let fail = true;
  f.api.tabs.createSplit = async ids => { if (fail) { fail = false; throw new Error('Transient browser failure'); } return create(ids); };
  await controller.handleMessage({ type: 'remote:activate', tabId: 12 }, sender);
  assert.match(f.messages.at(-1).text, /已恢复原组合/);
  assert.equal((await f.api.tabs.get(10)).splitViewId, (await f.api.tabs.get(11)).splitViewId);
  await Promise.all([12, 13].map(tabId => controller.handleMessage({ type: 'remote:activate', tabId }, sender)));
  assert.equal((await f.api.tabs.get(10)).splitViewId, (await f.api.tabs.get(13)).splitViewId);
  assert.equal(f.allTabs().length, 4);
  await controller.handleCommand('cancel-selection');
  assert.equal((await f.api.tabs.get(10)).splitViewId, (await f.api.tabs.get(11)).splitViewId);
});


test('重复选择浏览侧仍交给目标，菜单回总览，返回交给起始标签', async () => {
  const f = createChromeFixture([dashboard, original, target]);
  const controller = createRemoteController(f.api);
  const choose = id => controller.handleMessage({ type: 'remote:activate', tabId: id }, sender);
  await choose(12);
  await controller.handleCommand('show-dashboard');
  assert.equal(f.active(1), 10);
  assert.notEqual(f.messages.at(-1).focusDashboard, false);
  await choose(12);
  assert.equal(f.active(1), 12);
  assert.equal(f.messages.at(-1).focusDashboard, false);
  await controller.handleCommand('navigate-left', await f.api.tabs.get(12));
  assert.equal(f.active(1), 12);
  assert.equal(f.messages.at(-1).type, 'remote:action');
  await controller.handleCommand('cancel-selection');
  assert.equal(f.active(1), 11);
  assert.equal(f.messages.at(-1).focusDashboard, false);
});
