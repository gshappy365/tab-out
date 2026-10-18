# Issue #1：分屏比例保留调查

状态：**当前单总览实现尚未修复；已实测“保留独立分屏组合”的替代方向，待确认产品取舍。草稿 PR，不应作为功能交付合并。**

关联：[Issue #1](https://github.com/gshappy365/tab-out/issues/1)。基线：`split-screen` / `f4a6bdc`。调查日期：2026-10-16。

## 用户期望

从总览选择真实标签时保留切换前最新手动调整的比例。适用于鼠标、确定、返回及总览左右两侧；保持草稿、真实标签身份及 Muse 输入焦点适配。

## 结论

在“每窗口只保留一个总览并持续替换伙伴”的架构内，目前没有找到满足原需求的受支持实现路径。不能用复制网址、重新加载、关闭标签或固定比例代替。

2026-10-17 对照实验验证了另一个方向：每个浏览标签配一个独立总览，保留原生分屏组合，返回时激活原组合。此路径可以保留该组合自己调整过的比例，**不能把当前组合的比例自动应用到首次创建的新组合**，也改变了“每窗口一个总览”的已确认规则。因此它是待确认的替代方案，不是现有功能的完成修复。

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

接口能力探测只输出观测值，不把“缺少能力”写成必须长期保持的产品回归断言。未来 Chrome 增加接口后可用相同工具复核能力变化。

## 补充实验：回到同一真实标签（2026-10-17）

用户提出先记录分屏比例，再次回到相同标签时恢复。此实验单独验证往返行为，不把“没有比例写入 API”等同于已经实测 Chrome 的内部记忆行为。

新增 `roundtrip` 命令：要求总览与 A 已分屏，总览宽度占比与 50% 相差至少 8 个百分点；随后通过真实总览条目依次选择 B、A，比较返回后的总览占比，容差为 2 个百分点。输出 PASS/FAIL；FAIL 时进程最终退出码为 1。没有非均分样本时输出 PRECONDITION，不给出验收结论。

LCU 的拖动和键盘操作未能改变隔离窗口比例；用户手动调整分隔条，后续选择与测量由测试脚本执行。第一次样本为 462/892（总览占比 34.12%），真实总览点击 A → B → A 后为 677/677（50%），等待后仍为 50%。

第二次使用新增的 `compare` 命令，在同一个非均分起点依次比较两条路径：

```text
起点：D/A = 453/901，总览占比 0.3345642540620384
保留 D/A，新建 D2/B，激活 B 后再激活 A：
  PASS：D/A 仍为 453/901，占比 0.3345642540620384，splitViewId 不变
当前总览的真实点击路径 A → B → A（拆开再重建）：
  FAIL：D/A 为 677/677，占比 0.5，splitViewId 已改变
容差：0.02，失败时进程最终退出码为 1（实际已验证）
```

这支持“拆开并重建使比例丢失”的假设；不支持 Chrome 会为重新创建的相同标签组合恢复原比例，也排除了短暂布局延迟。记录比例数值本身没有提供写回手段；保留原组合则避免了写回需求。

对照实验只复制扩展总览，不复制、导航或重载 A/B。此测试没有覆盖新方案的生产路由、菜单/返回会话、跨窗口移动、关闭清理或 Muse 焦点回归，**不是完整实现或验收**。生产代码、权限及日常安装保持不变；隔离进程已退出并清理临时配置。

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
- `roundtrip`：从手动调好的非均分 D/A 开始，断言 A → B → A 是否恢复原比例；前置条件不满足时不判定。
- `compare`：在同一非均分起点先测试保留 D/A、另建 D2/B 并切回 A，再测试当前拆开重建路径；仅用于隔离调查，D2 随临时浏览器退出清理。
- `return`：通过现有遥控命令返回起始标签。
- `api`：检查候选比例接口是否存在，验证属性/参数的 API 校验结果。
- `move-between`：把 B 移到 D/A 之间，打印组合是否被拆开；仅适用于初始 D/A 组合。
- `quit` 或输入流结束：退出并清理临时配置。

## 后续可选方向

- 采用已实测的独立分屏组合方案：每个真实浏览标签配一个可复用总览，返回时激活原组合。须先确认允许多个总览及首次新组合默认比例，再设计总览筛选、选择同步、菜单/返回路由、关闭清理和跨窗口处理；不能直接把探测脚本当成生产实现。
- 等待 Chrome 暴露比例读写或保留视觉属性的成员替换接口，再实现并按 Issue 完整验收。
- 单独评估 macOS 原生辅助程序，通过无障碍接口读取和恢复原生分隔线。这需要新的扩展通信、安装与系统权限方案，以及失败恢复设计，超出当前扩展权限和部署边界，不能静默引入。

仅在有可验证的实现路径后将 PR 转为可合并，并满足 Issue 中的完整验收条件；本 PR 不关闭 Issue #1。
