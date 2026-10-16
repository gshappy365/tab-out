// Manual investigation for #1. Uses a disposable Chrome profile and local pages.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const readline = require('node:readline');
const { chromium } = require(process.env.TAB_OUT_PLAYWRIGHT_PATH || 'playwright');

(async () => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'tab-out-ratio-'));
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    const label = { '/A': 'A', '/B': 'B' }[req.url];
    if (!label) { res.writeHead(404); res.end(); return; }
    res.end(`<title>Ratio ${label}</title><h1>Ratio ${label}</h1><p>Local disposable ratio probe</p><textarea aria-label="Draft"></textarea>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let context;
  try {
    const extension = path.resolve(__dirname, '../extension');
    context = await chromium.launchPersistentContext(profile, {
      ...(process.env.TAB_OUT_CHROME_PATH ? { executablePath: process.env.TAB_OUT_CHROME_PATH } : { channel: 'chromium' }),
      headless: false, viewport: null,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--window-size=1400,900', '--window-position=0,0'],
    });
    await context.route('https://**/*', route => route.abort());
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const dashboard = await context.newPage();
    await dashboard.goto(`chrome-extension://${new URL(worker.url()).hostname}/index.html`);
    const base = `http://127.0.0.1:${server.address().port}`;
    const a = await context.newPage(); await a.goto(`${base}/A`);
    const b = await context.newPage(); await b.goto(`${base}/B`);
    for (const page of context.pages()) if (![dashboard, a, b].includes(page)) await page.close();
    const ids = await worker.evaluate(async ({ url, base }) => {
      const tabs = await chrome.tabs.query({});
      const d = tabs.find(t => t.url === url), a = tabs.find(t => t.url === `${base}/A`), b = tabs.find(t => t.url === `${base}/B`);
      await chrome.tabs.move(a.id, { index: d.index + 1 });
      await chrome.tabs.createSplit([d.id, a.id]);
      await chrome.tabs.update(d.id, { active: true });
      return { dashboard: d.id, a: a.id, b: b.id };
    }, { url: dashboard.url(), base });
    const measure = async () => {
      const tabs = await worker.evaluate(async ids => Promise.all(Object.values(ids).map(id => chrome.tabs.get(id))), ids);
      const widths = await Promise.all([dashboard, a, b].map(page => page.evaluate(() => innerWidth)));
      const d = tabs[0], partnerIndex = tabs.findIndex((t, i) => i > 0 && t.splitViewId === d.splitViewId);
      const ratio = d.splitViewId >= 0 && partnerIndex > 0 ? widths[0] / (widths[0] + widths[partnerIndex]) : null;
      console.log(JSON.stringify({ widths, dashboardFraction: ratio, tabs: tabs.map(t => ({ id: t.id, index: t.index, splitViewId: t.splitViewId, width: t.width })) }));
    };
    // All commands operate exclusively on the three tabs created in this profile.
    console.log('READY: drag the native separator, then enter measure; A/B select a real tab; return restores the initial partner; move-between probes tabs.move; api probes schema; quit cleans up.');
    for await (const input of readline.createInterface({ input: process.stdin })) {
      const command = input.trim();
      if (command === 'quit') break;
      if (['A', 'B'].includes(command)) {
        await dashboard.locator(`.remote-target[data-tab-id="${ids[command.toLowerCase()]}"]`).click();
        await dashboard.evaluate(() => chrome.runtime.sendMessage({ type: 'remote:get-state' }));
      } else if (command === 'return') {
        await dashboard.evaluate(() => chrome.runtime.sendMessage({ type: 'remote:execute', command: 'cancel-selection' }));
      } else if (command === 'move-between') {
        console.log(JSON.stringify(await worker.evaluate(async ids => {
          const d = await chrome.tabs.get(ids.dashboard), a = await chrome.tabs.get(ids.a);
          await chrome.tabs.move(ids.b, { index: Math.min(d.index, a.index) + 1 });
          return Promise.all([ids.dashboard, ids.a, ids.b].map(async id => {
            const tab = await chrome.tabs.get(id);
            return { id, index: tab.index, splitViewId: tab.splitViewId };
          }));
        }, ids)));
      } else if (command === 'api') {
        console.log(JSON.stringify(await worker.evaluate(async ids => {
          const errors = {};
          for (const [name, call] of [
            ['updateRatio', () => chrome.tabs.update(ids.dashboard, { splitViewRatio: 0.3 })],
            ['createRatio', () => chrome.tabs.createSplit([ids.dashboard, ids.b], { ratio: 0.3 })],
          ]) { try { await call(); errors[name] = 'unexpected success'; } catch (e) { errors[name] = e.message; } }
          return { updateSplit: typeof chrome.tabs.updateSplit, setSplitRatio: typeof chrome.tabs.setSplitRatio, errors };
        }, ids)));
      } else if (command !== 'measure') { console.log('Unknown command'); continue; }
      await measure();
    }
  } finally {
    process.stdin.pause();
    process.stdin.unref?.();
    if (context) await context.close();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(profile, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
