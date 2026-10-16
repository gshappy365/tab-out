# 两个仓库的融合事实

读取日期：2026-10-13。本文件记录源码事实与待验证项，不代表实施完成。

## 源码快照

- [SayAll / remote-mic-app](https://github.com/HD838A/remote-mic-app/tree/5ec5c003911c0d1fbc0135203c12b731968cbbef)
- [Tab Out](https://github.com/zarazhangrui/tab-out/tree/2c9b9c5a92d37e2bc1d1f121986f880467e0ef92)

## Tab Out 可复用与缺口

- 已是 Manifest V3 扩展，含 `tabs`、`activeTab`、`storage` 权限与后台 service worker；没有扩展 `commands`。[manifest.json](https://github.com/zarazhangrui/tab-out/blob/2c9b9c5a92d37e2bc1d1f121986f880467e0ef92/extension/manifest.json#L1-L21)
- `focusTab(url)` 会激活标签并聚焦对应窗口；按 URL 匹配时优先其他窗口，不能精确区分同网址标签。[app.js](https://github.com/zarazhangrui/tab-out/blob/2c9b9c5a92d37e2bc1d1f121986f880467e0ef92/extension/app.js#L118-L143)
- 标签行目前是不可直接键盘聚焦的 `div`，事件入口为鼠标点击；没有方向键、确定键或返回键导航。[标签行](https://github.com/zarazhangrui/tab-out/blob/2c9b9c5a92d37e2bc1d1f121986f880467e0ef92/extension/app.js#L771-L789)、[点击入口](https://github.com/zarazhangrui/tab-out/blob/2c9b9c5a92d37e2bc1d1f121986f880467e0ef92/extension/app.js#L1184-L1221)
- 卡片布局是 CSS 多列，卡内标签纵向排列；不是固定行列网格。同网址合并，每组仅前 8 项默认可见。[布局](https://github.com/zarazhangrui/tab-out/blob/2c9b9c5a92d37e2bc1d1f121986f880467e0ef92/extension/style.css#L220-L239)、[去重与折叠](https://github.com/zarazhangrui/tab-out/blob/2c9b9c5a92d37e2bc1d1f121986f880467e0ef92/extension/app.js#L827-L835)
- 读取标签时没有保留 Chrome 的 `index`。快速切换应直接读取当前窗口标签并按 `index` 排列，不能使用总览的网站分组顺序。[fetchTabs](https://github.com/zarazhangrui/tab-out/blob/2c9b9c5a92d37e2bc1d1f121986f880467e0ef92/extension/app.js#L35-L50)

## SayAll 可复用与约束

- 普通按键可发送自定义快捷键。带修饰键的普通快捷键会按序发送修饰键和主键事件。[KeyboardInjector](https://github.com/HD838A/remote-mic-app/blob/5ec5c003911c0d1fbc0135203c12b731968cbbef/Sources/RemoteMic/KeyboardInjector.swift#L385)
- 自定义应用动作能激活指定 App，等待前台切换，再发送已配置的快捷键；预设“打开 Chrome”只有打开能力，不能替代这个入口。[自定义应用模型](https://github.com/HD838A/remote-mic-app/blob/5ec5c003911c0d1fbc0135203c12b731968cbbef/Sources/RemoteMic/RemoteButtons.swift#L583)、[激活与聚焦](https://github.com/HD838A/remote-mic-app/blob/5ec5c003911c0d1fbc0135203c12b731968cbbef/Sources/RemoteMic/KeyboardInjector.swift#L512)
- 按 App 自动键位方案按前台 Bundle ID 匹配，缺失按键继承基础映射，显式“不执行”可以覆盖基础。[产品规范](https://github.com/HD838A/remote-mic-app/blob/5ec5c003911c0d1fbc0135203c12b731968cbbef/feature/button-mapping/PRODUCT_SPEC.md#L84)
- 自动 App 方案属于私有付费 Package；公开仓库不包含实现。这个边界影响“其他 App 前台时方向键不执行”的配置方案。[私有模块范围](https://github.com/HD838A/remote-mic-app/blob/5ec5c003911c0d1fbc0135203c12b731968cbbef/feature/quick-commands-private-integration/README.md#L13)、[适配层](https://github.com/HD838A/remote-mic-app/blob/5ec5c003911c0d1fbc0135203c12b731968cbbef/Sources/RemoteMic/MacroFeatureIntegration.swift#L98)
- 带修饰键的快捷键不按住连发；快速点按需开启“连续快速按”。双击与长按判定会增加单击等待，并取消普通按住重复。[硬件兼容约束](https://github.com/HD838A/remote-mic-app/blob/5ec5c003911c0d1fbc0135203c12b731968cbbef/Testing/HardwareCompatibilityContract.md#L51)、[手势处理](https://github.com/HD838A/remote-mic-app/blob/5ec5c003911c0d1fbc0135203c12b731968cbbef/Sources/RemoteMic/HIDRemoteMonitor.swift#L763)
- 语音键有独立按下/释放生命周期，应继续用于语音；新功能规范明确要求真实遥控器和第三方 App 实机验收。[新功能开发规范](https://github.com/HD838A/remote-mic-app/blob/5ec5c003911c0d1fbc0135203c12b731968cbbef/FEATURE_DEVELOPMENT.md#L11)

## 接口候选（推论）

SayAll 发送自定义快捷键，Tab Out 用扩展 commands 处理呼出与左右导航；总览内部再处理方向选择、确定和返回。用户已选择这个协作边界；依赖条件和细节仍在访谈，真实遥控器尚未验收。

Chrome 命令默认只在浏览器获得焦点时生效；系统或 Chrome 保留快捷键可能优先于扩展命令，不能随意复用内置切换快捷键作为可重定义输入。[Commands API](https://developer.chrome.com/docs/extensions/reference/api/commands)

标签激活与窗口聚焦是两个不同操作，跨窗口总览选择需要同时处理。[Tabs API](https://developer.chrome.com/docs/extensions/reference/api/tabs)

## 地址栏焦点约束

Chrome 官方说明新标签页会首先让地址栏获得键盘焦点。`tabs.create/update(active)` 与 `windows.update(focused)` 不承诺键盘输入一定进入页面文档；直接打开扩展 URL 的焦点行为仍需实测。依靠裸方向键、Enter、Escape 监听，不能据此保证呼出后立即可遥控。[新标签覆盖规范](https://developer.chrome.com/docs/extensions/develop/ui/override-chrome-pages#best-practices)、[键盘事件目标](https://developer.mozilla.org/en-US/docs/Web/API/Element/keydown_event)

候选解决方式：所有遥控导航键走 Chrome 扩展 commands，由后台转成标签切换或总览选择消息。Chrome 至多允许 4 个命令带默认建议快捷键，但可以声明更多命令，让用户手动绑定其余键；Enter/Escape 不在 commands 支持主键列表，应映射成受支持的组合键再表达“确定/返回”。[Commands API](https://developer.chrome.com/docs/extensions/reference/api/commands)

后台与扩展总览页面之间应使用同扩展的 `runtime.sendMessage` 或端口通信，并明确目标窗口/总览实例。`tabs.sendMessage` 的 Chrome 文档用途是给 content script 发消息，不能当作总览页面自身脚本的保证通路。[Runtime.sendMessage](https://developer.chrome.com/docs/extensions/reference/api/runtime#method-sendMessage)、[消息传递](https://developer.chrome.com/docs/extensions/develop/concepts/messaging)

## 待验证

- SayAll 激活 Chrome 后发送的快捷键是否实际触发扩展命令。
- 已安装 SayAll 是否具备完整按 App 自动方案能力。
- 总览激活后焦点是否进入选择界面；Chrome 地址栏获得焦点时，裸方向键不能假定会送到扩展页面。
- 重复 URL、目标标签被关闭、总览重用、service worker 恢复后的选中状态。
