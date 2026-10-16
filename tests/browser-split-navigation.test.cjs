const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require(process.env.TAB_OUT_PLAYWRIGHT_PATH || 'playwright');

test('Chrome 原生分屏：真实标签替换、状态保留和返回', async t => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'tab-out-split-test-'));
  const extension = path.resolve(__dirname, '../extension');
  const server = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(`<title>真实标签 ${request.url}</title><input id="draft"><div style="height:5000px">分屏测试</div>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {
      ...(process.env.TAB_OUT_CHROME_PATH ? { executablePath: process.env.TAB_OUT_CHROME_PATH } : { channel: 'chromium' }),
      headless: !process.env.TAB_OUT_HEADFUL, viewport: null,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--window-size=1400,1000'],
    });
    await context.route('https://**/*', route => route.abort());
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const supported = await worker.evaluate(() => typeof chrome.tabs.createSplit === 'function');
    assert.ok(supported, '分屏验收需要 Chrome 155+；通过 TAB_OUT_CHROME_PATH 指定，不以旧版跳过验收。');
    const extensionId = new URL(worker.url()).hostname;
    const dashboard = await context.newPage();
    await dashboard.goto(`chrome-extension://${extensionId}/index.html`);
    const original = await context.newPage(); await original.goto(`${base}/original`);
    const b = await context.newPage(); await b.goto(`${base}/duplicate`);
    const c = await context.newPage(); await c.goto(`${base}/duplicate`);
    for (const page of context.pages()) if (![dashboard, original, b, c].includes(page)) await page.close();
    const ids = await worker.evaluate(async ({ dashboardUrl, base }) => {
      const tabs = await chrome.tabs.query({});
      const d = tabs.find(t => t.url === dashboardUrl);
      const a = tabs.find(t => t.url === `${base}/original`);
      const duplicates = tabs.filter(t => t.url === `${base}/duplicate`).sort((x, y) => x.index - y.index);
      await chrome.tabs.move(a.id, { index: d.index + 1 });
      await chrome.tabs.createSplit([d.id, a.id]);
      await chrome.tabs.update(d.id, { active: true });
      return { d: d.id, a: a.id, b: duplicates[0].id, c: duplicates[1].id, windowId: d.windowId };
    }, { dashboardUrl: dashboard.url(), base });
    await dashboard.waitForSelector('body.split-mode .remote-target');
    assert.equal(await dashboard.locator('.remote-target').count(), 3);
    const activate = id => dashboard.locator(`.remote-target[data-tab-id="${id}"]`).click();
    const command = name => dashboard.evaluate(command => chrome.runtime.sendMessage({ type: 'remote:execute', command }), name);
    const pair = async id => worker.evaluate(async ({ d, id }) => {
      const a = await chrome.tabs.get(d), b = await chrome.tabs.get(id);
      return a.windowId === b.windowId && a.splitViewId >= 0 && a.splitViewId === b.splitViewId;
    }, { d: ids.d, id });
    const waitPair = async id => {
      await dashboard.waitForFunction(async ({ d, id }) => {
        const a = await chrome.tabs.get(d), b = await chrome.tabs.get(id);
        return a.windowId === b.windowId && a.splitViewId >= 0 && a.splitViewId === b.splitViewId;
      }, { d: ids.d, id });
      await dashboard.evaluate(() => chrome.runtime.sendMessage({ type: 'remote:get-state' }));
    };

    await t.test('普通总览分屏自动展示独立实例，鼠标替换保留内存、表单、滚动', async () => {
      await b.evaluate(() => { window.unsaved = { text: '内存状态' }; document.querySelector('#draft').value = '未提交草稿'; window.scrollTo(0, 1300); });
      await activate(ids.b); await waitPair(ids.b);
      assert.equal((await worker.evaluate(id => chrome.tabs.get(id), ids.a)).splitViewId, -1);
      assert.equal(await b.locator('#draft').inputValue(), '未提交草稿');
      assert.equal(await b.evaluate(() => window.unsaved.text), '内存状态');
      assert.equal(await b.evaluate(() => window.scrollY), 1300);
      assert.equal((await worker.evaluate(id => chrome.tabs.get(id), ids.d)).active, true);
      assert.equal(await dashboard.locator('body.split-mode.remote-mode').count(), 1);
      if (process.env.TAB_OUT_SPLIT_SCREENSHOT_PATH) {
        await dashboard.screenshot({ path: process.env.TAB_OUT_SPLIT_SCREENSHOT_PATH, fullPage: true });
      }
    });

    await t.test('浏览侧活动时方向仍控制总览，菜单保留起点，返回还原 A', async () => {
      await worker.evaluate(id => chrome.tabs.update(id, { active: true }), ids.b);
      await dashboard.evaluate(id => chrome.runtime.sendMessage({ type: 'remote:selection', selectedTabId: id }), ids.b);
      await command('navigate-down');
      const selected = Number(await dashboard.locator('.remote-selected').getAttribute('data-tab-id'));
      assert.notEqual(selected, ids.b);
      await b.locator('#draft').focus();
      await b.keyboard.press('Alt+Shift+E');
      await waitPair(selected);
      assert.equal(await b.locator('#draft').inputValue(), '未提交草稿');
      await activate(ids.c); await waitPair(ids.c);
      await command('show-dashboard');
      const state = await dashboard.evaluate(async () => (await chrome.runtime.sendMessage({ type: 'remote:get-state' })).state);
      assert.equal(state.originalTabId, ids.a);
      await command('cancel-selection'); await waitPair(ids.a);
      assert.equal(await pair(ids.a), true);
      assert.equal((await worker.evaluate(id => chrome.tabs.get(id), ids.b)).splitViewId, -1);
    });

    await t.test('跨窗口目标已有分屏：取出真实标签，伙伴保留', async () => {
      const other = await worker.evaluate(async base => {
        const w = await chrome.windows.create({ url: `${base}/other`, focused: false });
        const b = w.tabs[0];
        const c = await chrome.tabs.create({ windowId: w.id, url: `${base}/partner`, active: false });
        await chrome.tabs.createSplit([b.id, c.id]);
        return { b: b.id, c: c.id, windowId: w.id };
      }, base);
      await dashboard.waitForSelector(`.remote-target[data-tab-id="${other.b}"]`);
      await activate(other.b); await waitPair(other.b);
      const target = await worker.evaluate(id => chrome.tabs.get(id), other.b);
      const partner = await worker.evaluate(id => chrome.tabs.get(id), other.c);
      assert.equal(target.windowId, ids.windowId);
      assert.equal(partner.windowId, other.windowId);
      assert.equal(partner.splitViewId, -1);
      await command('cancel-selection'); await waitPair(ids.a);
    });

    await t.test('总览在右侧仍保持右侧，固定目标失败不改变布局', async () => {
      await worker.evaluate(async ids => {
        const d = await chrome.tabs.get(ids.d);
        await chrome.tabs.unsplit(d.splitViewId);
        const a = await chrome.tabs.get(ids.a);
        await chrome.tabs.move(ids.d, { index: a.index + 1 - (d.index < a.index ? 1 : 0) });
        await chrome.tabs.createSplit([ids.a, ids.d]);
        await chrome.tabs.update(ids.d, { active: true });
      }, ids);
      await activate(ids.b); await waitPair(ids.b);
      const d = await worker.evaluate(id => chrome.tabs.get(id), ids.d);
      assert.ok((await worker.evaluate(id => chrome.tabs.get(id), ids.b)).index < d.index);
      await worker.evaluate(id => chrome.tabs.update(id, { pinned: true }), ids.c);
      await activate(ids.c);
      await dashboard.waitForFunction(() => document.querySelector('#remoteStatus').textContent.includes('不兼容'));
      assert.equal(await pair(ids.b), true);
      await worker.evaluate(id => chrome.tabs.update(id, { pinned: false }), ids.c);
    });

    await t.test('手动重组结束旧会话，退出分屏后恢复普通总览行为', async () => {
      await worker.evaluate(async ids => {
        await chrome.tabs.unsplit((await chrome.tabs.get(ids.d)).splitViewId);
        const d = await chrome.tabs.get(ids.d), c = await chrome.tabs.get(ids.c);
        await chrome.tabs.move(c.id, { index: d.index + 1 - (c.index < d.index ? 1 : 0) });
        await chrome.tabs.createSplit([d.id, c.id]);
        await chrome.tabs.update(d.id, { active: true });
      }, ids);
      await command('cancel-selection');
      await dashboard.waitForFunction(() => document.querySelector('#remoteStatus').textContent.includes('尚未更换'));
      assert.equal(await pair(ids.c), true);
      await worker.evaluate(async id => chrome.tabs.unsplit((await chrome.tabs.get(id)).splitViewId), ids.d);
      await dashboard.waitForFunction(() => !document.body.classList.contains('remote-mode'));
      await worker.evaluate(id => chrome.tabs.update(id, { active: true }), ids.a);
      await command('show-dashboard');
      await activate(ids.b);
      await dashboard.waitForFunction(() => !document.body.classList.contains('remote-mode'));
      assert.equal((await worker.evaluate(id => chrome.tabs.get(id), ids.b)).active, true);
      assert.equal((await worker.evaluate(id => chrome.tabs.get(id), ids.d)).splitViewId, -1);
    });
  } finally {
    if (context) await context.close();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(profile, { recursive: true, force: true });
  }
});
