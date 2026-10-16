const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require(process.env.TAB_OUT_PLAYWRIGHT_PATH || 'playwright');

test('真实扩展：标签展示、导航、确定、返回与快捷键', async t => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'tab-out-remote-test-'));
  const extension = path.resolve(__dirname, '../extension');
  const server = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(`<title>测试标签 ${request.url}</title><p>Tab Out Remote test</p>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {
      ...(process.env.TAB_OUT_CHROME_PATH ? { executablePath: process.env.TAB_OUT_CHROME_PATH } : { channel: 'chromium' }), headless: true,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
      viewport: { width: 1280, height: 900 },
      timezoneId: 'Asia/Shanghai',
    });
    await context.route('https://**/*', route => route.abort());
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).hostname;
    const source = await context.newPage();
    await source.goto(`${base}/source`);
    for (const page of context.pages()) if (page !== source) await page.close();
    for (let index = 0; index < 10; index++) {
      const page = await context.newPage();
      await page.goto(`${base}/page-${index}`);
    }
    const duplicate = await context.newPage();
    await duplicate.goto(`${base}/source`);
    const sourceTab = await worker.evaluate(async url => {
      const tabs = await chrome.tabs.query({});
      const source = tabs.find(tab => tab.url === url);
      await chrome.tabs.update(source.id, { active: true });
      return source;
    }, `${base}/source`);
    const dashboardPromise = context.waitForEvent('page');
    await worker.evaluate(() => remoteController.handleCommand('show-dashboard'));
    const dashboard = await dashboardPromise;
    await dashboard.waitForURL(`chrome-extension://${extensionId}/index.html?remote=1`);
    await dashboard.waitForSelector('.remote-target', { timeout: 10000 });
    assert.equal(await dashboard.locator('.remote-target').count(), 12);
    assert.equal(await dashboard.locator(`.remote-selected[data-tab-id="${sourceTab.id}"]`).count(), 1);
    assert.equal(await dashboard.locator('.remote-window-label').count(), 12);
    assert.equal(await dashboard.locator('.mission-card').first().evaluate(element => getComputedStyle(element).opacity), '1');

    await t.test('扩展命令注册成功，并提示三个待绑定命令', async () => {
      const commands = await dashboard.evaluate(async () => (await chrome.commands.getAll()).filter(command => !command.name.startsWith('_')));
      assert.equal(commands.length, 7);
      assert.equal(commands.filter(command => command.shortcut).length, 4);
      assert.match(await dashboard.locator('#remoteBindings').textContent(), /上、下、返回/);
    });

    await t.test('总览方向移动和边界，不需要页面 DOM 获得焦点', async () => {
      const firstPage = await dashboard.evaluate(async url => {
        return (await chrome.tabs.query({})).find(tab => tab.url === url).id;
      }, `${base}/page-0`);
      const execute = command => dashboard.evaluate(command =>
        chrome.runtime.sendMessage({ type: 'remote:execute', command }), command);
      await execute('navigate-down');
      assert.equal(await dashboard.locator(`.remote-selected[data-tab-id="${firstPage}"]`).count(), 1);
      await execute('navigate-up');
      await execute('navigate-left');
      assert.equal(await dashboard.locator(`.remote-selected[data-tab-id="${sourceTab.id}"]`).count(), 1);
      if (process.env.TAB_OUT_SCREENSHOT_PATH) {
        await dashboard.screenshot({ path: process.env.TAB_OUT_SCREENSHOT_PATH, fullPage: true });
      }
    });

    await t.test('鼠标选择重复实例时激活准确标签，离开后恢复鼠标模式', async () => {
      const duplicateId = await dashboard.evaluate(async ({ url, original }) => {
        return (await chrome.tabs.query({})).find(tab => tab.url === url && tab.id !== original).id;
      }, { url: `${base}/source`, original: sourceTab.id });
      await dashboard.locator(`.remote-target[data-tab-id="${duplicateId}"]`).click();
      await dashboard.waitForFunction(() => !document.body.classList.contains('remote-mode'));
      const active = await worker.evaluate(async windowId =>
        (await chrome.tabs.query({ active: true, windowId }))[0].id, sourceTab.windowId);
      assert.equal(active, duplicateId);
    });

    await t.test('默认快捷键在网页输入框获得焦点时切换标签', async () => {
      const original = await worker.evaluate(async windowId =>
        (await chrome.tabs.query({ active: true, windowId }))[0].id, sourceTab.windowId);
      await duplicate.evaluate(() => {
        const input = document.createElement('input');
        input.id = 'test-input'; input.value = '保留输入'; document.body.append(input); input.focus();
      });
      await duplicate.keyboard.press('Alt+Shift+L');
      await dashboard.waitForFunction(async ({ windowId, original }) => {
        return (await chrome.tabs.query({ active: true, windowId }))[0].id !== original;
      }, { windowId: sourceTab.windowId, original }, { timeout: 3000 });
      assert.equal(await duplicate.locator('#test-input').inputValue(), '保留输入');
    });

    await t.test('再次菜单重用总览，返回恢复新的来源标签', async () => {
      const original = await worker.evaluate(async windowId =>
        (await chrome.tabs.query({ active: true, windowId }))[0].id, sourceTab.windowId);
      const dashboardId = await dashboard.evaluate(async () => (await chrome.tabs.getCurrent()).id);
      await dashboard.evaluate(() => chrome.runtime.sendMessage({ type: 'remote:execute', command: 'show-dashboard' }));
      const after = await dashboard.evaluate(async () => (await chrome.tabs.getCurrent()).id);
      assert.equal(after, dashboardId);
      await dashboard.evaluate(() => chrome.runtime.sendMessage({ type: 'remote:execute', command: 'cancel-selection' }));
      const active = await worker.evaluate(async windowId =>
        (await chrome.tabs.query({ active: true, windowId }))[0].id, sourceTab.windowId);
      assert.equal(active, original);
    });

    await t.test('跨窗口重复标签精确激活，每个窗口的总览消息相互隔离', async () => {
      const secondWindow = await worker.evaluate(url => chrome.windows.create({ url, focused: false }), `${base}/source`);
      const targetId = secondWindow.tabs[0].id;
      await dashboard.evaluate(() => chrome.runtime.sendMessage({ type: 'remote:execute', command: 'show-dashboard' }));
      await dashboard.waitForSelector(`.remote-target[data-tab-id="${targetId}"]`);
      await dashboard.locator(`.remote-target[data-tab-id="${targetId}"]`).click();
      await dashboard.waitForFunction(() => !document.body.classList.contains('remote-mode'));
      const focused = await worker.evaluate(() => chrome.windows.getLastFocused());
      assert.equal(focused.id, secondWindow.id);
      const dashboardPromise = context.waitForEvent('page');
      await worker.evaluate(windowId => remoteController.handleCommand('show-dashboard', { windowId }), secondWindow.id);
      const secondDashboard = await dashboardPromise;
      await secondDashboard.waitForSelector('.remote-target');
      assert.equal(await dashboard.locator('.remote-selected').count(), 0);
      await secondDashboard.evaluate(() => chrome.runtime.sendMessage({ type: 'remote:execute', command: 'navigate-down' }));
      assert.equal(await dashboard.locator('.remote-selected').count(), 0);
      await secondDashboard.evaluate(() => chrome.runtime.sendMessage({ type: 'remote:execute', command: 'cancel-selection' }));
      const active = await worker.evaluate(async windowId => (await chrome.tabs.query({ active: true, windowId }))[0].id, secondWindow.id);
      assert.equal(active, targetId);
    });

    await t.test('来源关闭时显示取消失败原因，标题中的 HTML 按文本显示', async () => {
      await worker.evaluate(windowId => chrome.windows.update(windowId, { focused: true }), sourceTab.windowId);
      await dashboard.evaluate(() => chrome.runtime.sendMessage({ type: 'remote:execute', command: 'show-dashboard' }));
      const state = await dashboard.evaluate(async () => (await chrome.runtime.sendMessage({ type: 'remote:get-state' })).state);
      await source.evaluate(() => { document.title = '<img id="title-injection" src=x onerror="alert(1)">'; });
      await dashboard.waitForFunction(() => document.querySelector('.remote-target')?.textContent.includes('title-injection'));
      assert.equal(await dashboard.locator('#title-injection').count(), 0);
      await dashboard.evaluate(id => chrome.tabs.remove(id), state.sourceTabId);
      await dashboard.evaluate(() => chrome.runtime.sendMessage({ type: 'remote:execute', command: 'cancel-selection' }));
      assert.match(await dashboard.locator('#remoteStatus').textContent(), /来源标签已关闭/);
      assert.equal(await dashboard.locator('body.remote-mode').count(), 1);
      await dashboard.locator(`.remote-target[data-tab-id="${sourceTab.id}"]`).click();
      await dashboard.waitForFunction(() => !document.body.classList.contains('remote-mode'));
      assert.equal(await dashboard.locator('#title-injection').count(), 0);
    });
  } finally {
    if (context) await context.close();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(profile, { recursive: true, force: true });
  }
});
