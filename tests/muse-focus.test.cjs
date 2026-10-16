const test = require('node:test');
const assert = require('node:assert/strict');
const { createMuseFocus, focusComposer } = require('../extension/muse-focus.js');

function fixture(url = 'https://muse.ai/', granted = true) {
  const calls = [];
  return { calls, api: {
    tabs: { get: async () => ({ id: 12, windowId: 1, active: true, url }) },
    permissions: { contains: async query => { calls.push(query); return granted; } },
    scripting: { executeScript: async query => { calls.push(query); return [{ frameId: 0, result: { status: 'focused' } }]; } },
  } };
}

test('Muse 仅在精确 HTTPS 站点已授权后注入主 frame', async () => {
  const f = fixture();
  assert.equal((await createMuseFocus(f.api).restore(12)).status, 'focused');
  assert.deepEqual(f.calls[0], { origins: ['https://muse.ai/*'] });
  assert.deepEqual(f.calls[1].target, { tabId: 12 });
  assert.equal(f.calls[1].func, focusComposer);
});

test('Hark、子域名、相似域名及无权限时不注入', async () => {
  for (const url of ['https://hark.com/chat', 'https://sub.muse.ai/', 'https://muse.ai.evil.test/', 'http://muse.ai/', 'chrome://settings']) {
    const f = fixture(url);
    assert.equal((await createMuseFocus(f.api).restore(12)).status, 'unsupported');
    assert.equal(f.calls.length, 0);
  }
  const f = fixture('https://muse.ai/', false);
  assert.equal((await createMuseFocus(f.api).restore(12)).status, 'not-granted');
  assert.equal(f.calls.length, 1);
});

test('失效脚本权限失败可反馈，不伪装为聚焦成功', async () => {
  const f = fixture();
  f.api.scripting.executeScript = async () => { throw new Error('Permission revoked'); };
  assert.equal((await createMuseFocus(f.api).restore(12)).status, 'unavailable');
});

test('已切走的 Muse 标签不注入，不抢焦点', async () => {
  const f = fixture();
  f.api.tabs.get = async () => ({ id: 12, active: false, url: 'https://muse.ai/' });
  assert.equal((await createMuseFocus(f.api).restore(12)).status, 'unsupported');
  assert.equal(f.calls.length, 0);
});
