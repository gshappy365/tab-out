const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require(process.env.TAB_OUT_PLAYWRIGHT_PATH || 'playwright');

test('Muse 精确消息框：失焦后选择、原选区、返回、无歧义和防抢焦点', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'tab-out-muse-'));
  const extension = path.join(temp, 'extension');
  await fs.cp(path.resolve(__dirname, '../extension'), extension, { recursive: true, filter: source => !source.endsWith('config.local.js') });
  // Only the isolated test copy simulates a site permission already granted by the user.
  const manifest = JSON.parse(await fs.readFile(path.join(extension, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.optional_host_permissions, ['https://muse.ai/*']);
  manifest.host_permissions = ['https://muse.ai/*'];
  delete manifest.optional_host_permissions;
  await fs.writeFile(path.join(extension, 'manifest.json'), JSON.stringify(manifest));
  let context;
  try {
    context = await chromium.launchPersistentContext(path.join(temp, 'profile'), {
      ...(process.env.TAB_OUT_CHROME_PATH ? { executablePath: process.env.TAB_OUT_CHROME_PATH } : { channel: 'chromium' }),
      headless: !process.env.TAB_OUT_HEADFUL,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    });
    await context.route('https://**/*', async route => {
      if (new URL(route.request().url()).origin !== 'https://muse.ai') return route.abort();
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<title>Muse fixture</title><p id="body">聊天正文</p><input aria-label="搜索"><textarea aria-label="消息">原草稿</textarea>' });
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const id = new URL(worker.url()).hostname;
    const dashboard = await context.newPage(); await dashboard.goto(`chrome-extension://${id}/index.html`);
    const a = await context.newPage(); await a.goto('https://muse.ai/');
    const b = await context.newPage(); await b.goto('https://muse.ai/other');
    for (const page of context.pages()) if (![dashboard, a, b].includes(page)) await page.close();
    const ids = await worker.evaluate(async dashboardUrl => {
      const tabs = await chrome.tabs.query({});
      const d = tabs.find(t => t.url === dashboardUrl), a = tabs.find(t => t.url === 'https://muse.ai/'), b = tabs.find(t => t.url === 'https://muse.ai/other');
      await chrome.tabs.move(a.id, { index: d.index + 1 });
      await chrome.tabs.createSplit([d.id, a.id]);
      await chrome.tabs.update(d.id, { active: true });
      return { d: d.id, a: a.id, b: b.id };
    }, dashboard.url());
    await dashboard.waitForSelector('body.split-mode .remote-target');
    const select = async target => {
      await dashboard.locator(`.remote-target[data-tab-id="${target}"]`).click();
      await dashboard.evaluate(() => chrome.runtime.sendMessage({ type: 'remote:get-state' }));
    };
    const command = name => dashboard.evaluate(command => chrome.runtime.sendMessage({ type: 'remote:execute', command }), name);
    await t.test('没有编辑焦点时鼠标选择可主动聚焦消息框，键入而不改搜索框', async () => {
      await b.locator('#body').click();
      await select(ids.b);
      assert.equal(await b.evaluate(() => document.activeElement.getAttribute('aria-label')), '消息');
      await b.keyboard.insertText('续写');
      assert.equal(await b.locator('textarea').inputValue(), '续写原草稿');
      assert.equal(await b.locator('input').inputValue(), '');
    });
    await t.test('已有选区保留，菜单与方向不执行站点自动聚焦', async () => {
      await b.locator('textarea').evaluate(el => el.setSelectionRange(0, 2));
      await command('show-dashboard');
      assert.equal((await worker.evaluate(id => chrome.tabs.get(id), ids.d)).active, true);
      await command('confirm-selection');
      await b.keyboard.insertText('替换');
      assert.equal(await b.locator('textarea').inputValue(), '替换原草稿');
      await command('navigate-down');
      assert.equal((await worker.evaluate(id => chrome.tabs.get(id), ids.b)).active, true);
    });
    await t.test('返回到无原输入焦点的 Muse 同样主动聚焦', async () => {
      await command('cancel-selection');
      assert.equal((await worker.evaluate(id => chrome.tabs.get(id), ids.a)).active, true);
      assert.equal(await a.evaluate(() => document.activeElement.getAttribute('aria-label')), '消息');
    });
    await t.test('歧义、缺失、禁用不猜测，不自动聚焦其他文本框', async () => {
      const run = () => worker.evaluate(id => TabOutMuseFocus.createMuseFocus(chrome).restore(id), ids.a);
      await a.locator('#body').click();
      await a.evaluate(() => { const clone = document.querySelector('textarea').cloneNode(); document.body.append(clone); });
      assert.equal((await run()).status, 'ambiguous');
      await a.locator('textarea').last().evaluate(el => el.remove());
      await a.locator('textarea').evaluate(el => { el.disabled = true; });
      assert.equal((await run()).status, 'missing');
      assert.notEqual(await a.evaluate(() => document.activeElement.tagName), 'INPUT');
      await a.locator('textarea').evaluate(el => { el.disabled = false; });
    });
    await t.test('延迟出现的编辑区可恢复，用户转去其他页后不抢回', async () => {
      await a.locator('#body').click();
      await a.locator('textarea').evaluate(el => { el.hidden = true; setTimeout(() => { el.hidden = false; }, 180); });
      assert.equal((await worker.evaluate(id => TabOutMuseFocus.createMuseFocus(chrome).restore(id), ids.a)).status, 'focused');
      await command('show-dashboard');
      assert.equal((await worker.evaluate(id => TabOutMuseFocus.createMuseFocus(chrome).restore(id), ids.a)).status, 'unsupported');
    });
  } finally {
    if (context) await context.close();
    await fs.rm(temp, { recursive: true, force: true });
  }
});
