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


const ratioPermission = { permissions: ['nativeMessaging'] };
const nativeRatio = globalThis.TabOutNativeRatio;
const ratioSetting = nativeRatio.setting;
const ratioHost = nativeRatio.host;
const ratioStatus = document.getElementById('ratio-status');
const ratioEnable = document.getElementById('ratio-enable');
const ratioDisable = document.getElementById('ratio-disable');
const ratioCheck = document.getElementById('ratio-check');
async function refreshRatio() {
  const mac = (await chrome.runtime.getPlatformInfo()).os === 'mac';
  const enabled = !!(await chrome.storage.local.get(ratioSetting))[ratioSetting];
  const permitted = await chrome.permissions.contains(ratioPermission);
  ratioEnable.hidden = enabled && permitted;
  ratioEnable.disabled = !mac;
  ratioDisable.hidden = !enabled && !permitted;
  ratioCheck.disabled = !mac || !permitted;
  ratioStatus.textContent = !mac ? '分屏比例保持目前仅支持 macOS。' : enabled && permitted
    ? '已开启：选择或返回后恢复你切换前的分屏比例。' : '尚未开启：保持原有分屏切换行为。';
}
ratioEnable.addEventListener('click', async () => {
  try {
    const granted = await chrome.permissions.request(ratioPermission);
    await chrome.storage.local.set({ [ratioSetting]: granted });
    await refreshRatio();
    if (!granted) ratioStatus.textContent = '未开启：尚未授予本地辅助程序连接权限。';
  } catch { ratioStatus.textContent = '开启未完成，请重试。'; }
});
ratioDisable.addEventListener('click', async () => {
  try {
    await chrome.storage.local.set({ [ratioSetting]: false });
    await chrome.permissions.remove(ratioPermission);
    await refreshRatio();
  } catch { ratioStatus.textContent = '关闭未完成，请重试。'; }
});
ratioCheck.addEventListener('click', async () => {
  ratioCheck.disabled = true;
  let timer;
  try {
    const requestId = crypto.randomUUID();
    const response = await Promise.race([
      chrome.runtime.sendNativeMessage(ratioHost, { version: 2, requestId, operation: 'status' }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), 8000); }),
    ]);
    if (response?.version !== 2 || response.requestId !== requestId) throw new Error('response');
    ratioStatus.textContent = response.status === 'already-correct' ? '辅助程序连接正常，辅助功能已授权。'
      : response.status === 'permission-required' ? '请在 macOS 系统设置 → 隐私与安全性 → 辅助功能中检查 tab-out-split-ratio 辅助程序及当前 Chrome 的授权。'
      : '辅助程序拒绝了检查，请检查安装和 Chrome 环境。';
  } catch { ratioStatus.textContent = '无法连接辅助程序，请先按安装说明注册到当前 Chrome 环境。'; }
  finally { clearTimeout(timer); ratioCheck.disabled = false; }
});
chrome.permissions.onAdded.addListener(() => refreshRatio().catch(() => {}));
chrome.permissions.onRemoved.addListener(() => refreshRatio().catch(() => {}));
refreshRatio().catch(() => { ratioStatus.textContent = '无法读取分屏设置，请刷新重试。'; });
