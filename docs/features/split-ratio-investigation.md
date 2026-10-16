# Issue #1：分屏比例保留调查

状态：**受当前浏览器扩展 API 限制，尚未修复；草稿 PR，不应作为功能交付合并。**

关联：[Issue #1](https://github.com/gshappy365/tab-out/issues/1)。基线：`split-screen` / `f4a6bdc`。调查日期：2026-10-16。

## 用户期望

从总览选择真实标签时保留切换前最新手动调整的比例。适用于鼠标、确定、返回及总览左右两侧；保持草稿、真实标签身份及 Muse 输入焦点适配。

## 结论

目前没有找到在既定的 Chrome 扩展架构内满足需求的受支持实现路径。不能用复制网址、重新加载、关闭标签或固定比例代替。

生产代码没有改动，权限没有扩大，个人 Chrome 中安装的扩展没有更新。Issue 保持打开。

## 依据

1. [Chrome Tabs API](https://developer.chrome.com/docs/extensions/reference/api/tabs#method-createSplit) 的 `createSplit` 只有两个标签 ID 参数；没有比例或视觉属性参数。`tabs.update` 的属性中没有分屏比例，`splitWithTabId` 也要求目标尚未分屏，不能向既有分屏替换伙伴。
2. [Chrome 官方分屏 API 说明](https://developer.chrome.com/blog/split-view-api-extensions)说明了创建、识别、拆开分屏的能力；没有提供修改比例或替换分屏成员的接口。
3. 实际 Chrome 155.0.8059.84 运行中，`tabs.updateSplit` 和 `tabs.setSplitRatio` 均不存在。尝试传入比例时被 API 签名校验拒绝，而非忽略后成功。
4. [Chromium 155 的 Tabs schema](https://chromium.googlesource.com/chromium/src/+/refs/tags/155.0.8059.84/chrome/common/extensions/api/tabs.json)与上述签名一致。
5. [Chromium 155 的 MoveWithinSplitView / MoveFromSplitView 测试](https://chromium.googlesource.com/chromium/src/+/refs/tags/155.0.8059.84/chrome/browser/extensions/api/tabs/tabs_test.cc)明确验证：将普通标签移入两分屏标签之间，或将成员移出，都会解除原组合。不能通过 `tabs.move` 偷换成员并保留原分屏。
6. 本项目 `extension/split-navigation.js` 正是先拆开，再创建新分屏；因此原分屏的视觉比例没有随之保留。同一伙伴的重复选择已走不重建路径，不是本次缺陷所在。

这些证据支持“当前公开扩展接口没有可用路径”的工程判断，不代表所有未来版本或 Chrome 内部原生代码都无法实现。

## 实际探测结果

工具：`tools/probe-split-ratio.cjs`，使用隔离 Chrome for Testing 155.0.8059.84、临时配置与本地 A/B 页；没有连接个人 Chrome 的调试接口。

```text
updateSplit: undefined
setSplitRatio: undefined
update({splitViewRatio: 0.3}): Unexpected property: 'splitViewRatio'
createSplit([D, B], {ratio: 0.3}): No matching signature

初始 D/A 可视宽度：677 / 677，比例 0.5
将 B 移到 D/A 中间：D、A、B 的 splitViewId 全部变为 -1
分屏已被解除，而非保留原组合替换浏览侧
```

该工具只输出观测值，不把“缺少能力”写成必须长期保持的产品回归断言。未来 Chrome 增加接口后可用相同工具复核能力变化。

## LCU 观察与验证缺口

已通过 LCU 打开隔离 Chrome 的原生分屏，并另在日常 Chrome 新建只含本地 A/B 与总览的测试窗口。没有操作业务网页、发布截图或修改扩展安装。

隔离窗口的拖动遇到 LCU 坐标映射错误；AX 分隔线动作没有测得比例变化。日常 Chrome 测试窗口的拖动也未确认有效比例改变。因此**没有完成“30:70 → 选择 B → 仍为 30:70”的本机验收，不能宣称需求已实现或验收通过**。

日常 Chrome 的本次测试窗口已关闭；隔离测试进程正常退出并清理临时配置。原业务窗口保留。

## 复跑方式

需要 Node 20+、Playwright，以及支持分屏的 Chrome 155+。可沿用项目测试环境变量：

```sh
TAB_OUT_PLAYWRIGHT_PATH=/path/to/node_modules/playwright \
TAB_OUT_CHROME_PATH="/path/to/Google Chrome for Testing" \
node tools/probe-split-ratio.cjs
```

程序就绪后输入命令：

- `measure`：打印当前两个可视成员的宽度及总览占比；未分屏时占比为 null，普通后台标签宽度可能是旧值。
- `A` / `B`：通过总览点击对应真实标签，随后测量。
- `return`：通过现有遥控命令返回起始标签。
- `api`：检查候选比例接口是否存在，验证属性/参数的 API 校验结果。
- `move-between`：把 B 移到 D/A 之间，打印组合是否被拆开；仅适用于初始 D/A 组合。
- `quit` 或输入流结束：退出并清理临时配置。

## 后续可选方向

- 等待 Chrome 暴露比例读写或保留视觉属性的成员替换接口，再实现并按 Issue 完整验收。
- 单独评估 macOS 原生辅助程序，通过无障碍接口读取和恢复原生分隔线。这需要新的扩展通信、安装与系统权限方案，以及失败恢复设计，超出当前扩展权限和部署边界，不能静默引入。

仅在有可验证的实现路径后将 PR 转为可合并，并满足 Issue 中的完整验收条件；本 PR 不关闭 Issue #1。
