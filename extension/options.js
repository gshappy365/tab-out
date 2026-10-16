'use strict';

const museOrigin = { origins: ['https://muse.ai/*'] };
const enable = document.getElementById('enable');
const disable = document.getElementById('disable');
const status = document.getElementById('status');

async function refresh() {
  const granted = await chrome.permissions.contains(museOrigin);
  enable.hidden = granted;
  disable.hidden = !granted;
  status.textContent = granted ? '已开启：切换到 Muse 后自动聚焦消息框。' : '尚未授权：Muse 沿用浏览器自身的焦点恢复。';
}

enable.addEventListener('click', async () => {
  try {
    const granted = await chrome.permissions.request(museOrigin);
    await refresh();
    if (!granted) status.textContent = '未开启：你尚未授予 Muse 访问权限。';
  } catch { status.textContent = '授权未完成，请重试。'; }
});
disable.addEventListener('click', async () => {
  try { await chrome.permissions.remove(museOrigin); await refresh(); }
  catch { status.textContent = '撤销未完成，请重试。'; }
});
chrome.permissions.onAdded.addListener(refresh);
chrome.permissions.onRemoved.addListener(refresh);
refresh().catch(() => { status.textContent = '无法读取授权状态，请刷新重试。'; });
