# macOS 分屏比例保持接入：真实 Chrome 本地验收

日期：2026-10-18，Asia/Shanghai。范围与边界：仅隔离 user-data-dir 中的测试 Chrome 与测试扩展副本；未修改日常加载的扩展、未写日常 Chrome 用户级 NativeMessagingHosts、未推送、未发布、未新建 PR。Muse/Hark 登录后的业务站点验收按用户要求继续推迟，本记录不把本地 textarea 结果当成业务站点通过。

## 结果

正式接入的本地验收通过（固定 3:7 版本）：真实 Native Messaging 健康检查返回 `{version:2,status:"already-correct",reason:"ready"}`；鼠标选择、遥控确定、遥控返回、总览在右、窗口缩放后，真实分屏总览:浏览侧均为 3:7（实测 0.30007 / 0.29983），总览数量始终为 1，原浏览标签输入框保持 AX 焦点，未点击输入框直接键入的标记追加在原草稿之后。四类 Native 失败（host 缺失、坏响应、超时、permission-required）只产生提示、不回滚已完成的真实标签切换，重复伙伴选择保持比例与焦点。

## 阻塞原因一：辅助功能 TCC 记录绑定旧构建（已解决）

上一会话未通过的现象是健康检查始终为 `{status:"permission-required",reason:"accessibility"}`，即使系统设置中 `tab-out-split-ratio` 开关显示 on。按用户已批准的方案重新登记（未重建二进制、未删除 TCC 数据库、未重置其他授权）：

1. 系统设置 → 隐私与安全性 → 辅助功能中选中 `tab-out-split-ratio` 行，点「移除」；macOS 弹出「正在尝试修改你的系统设置」，由用户本人完成 Touch ID / 密码。
2. 点「添加」→ `Command+Shift+G` → 输入固定 helper 绝对路径 → 打开，新 `tab-out-split-ratio` 行自动为 on。
3. 未改动测试 Chrome（`Tab Out Integration Chrome`）及 `tab-out-split-ratio` 之外的任何权限项。

固定二进制未改变，仍为：

`/Users/gaoshan/Documents/Codex/2026-10-13/shi-y/work/publish-tab-out/native/macos/build/tab-out-split-ratio`

SHA256 `7d516d20054b00286c9fe24fc3a707413930f7975e6f63f1034af0d35e074c7a`，ad-hoc 签名，identifier `com.tab_out_remote.split_ratio`，CDHash `ab6e0c5b35017967b46328f73eac74b8981feb1b`。

重新登记后，同一 helper 的健康检查立即从 `permission-required` 变为 `already-correct`。因此可以确认：旧记录未对当前构建生效；本记录不进一步推断 TCC 数据库内部字段（未读取、未修改 TCC.db）。ad-hoc 签名的 designated requirement 绑定 cdhash，任何重建都可能再次需要同样的重新登记，不能假定授权自动延续。

## 阻塞原因二：隔离 profile 中 Chrome 复用了旧扩展 service worker 脚本（测试环境问题，已解决）

TCC 修复后健康检查已通过，但扩展内部 apply 曾返回 `host-unavailable`，真实比例不变。定位结果：

- 直接从扩展页调用同一 `native-ratio.js` 模块，apply 返回 `{status:"adjusted"}`，真实宽度 403/940 = 0.300。
- 服务 worker 中加载的 `TabOutNativeRatio` 与磁盘/`fetch(chrome.runtime.getURL('native-ratio.js'))` 内容不一致：fetch 为新内容，worker 执行的仍是旧脚本；`profile-v2/Default/Service Worker/ScriptCache` 中有旧脚本缓存。Chrome 在重复启动未打包扩展时复用了缓存的 service worker 脚本。
- 仅清理隔离 profile 的 `Default/Service Worker`（SW 脚本缓存，非登录数据、非扩展存储）后，每次启动都执行磁盘上的当前副本，扩展链路恢复正常。该问题属于验收 profile 缓存，不是 `extension/` 源码缺陷；`local.cjs` 已在启动时自动清理这一缓存。

## 验收环境

- macOS 14.7.3（23H417 arm64）；Google Chrome for Testing 155.0.8059.84。
- 源码副本：`work/publish-tab-out`（分支 `feature/native-split-ratio`，未提交、未推送）。
- 隔离驱动：`work/native-ratio-integration/local.cjs`；隔离 profile `profile-v2`；扩展 ID `nmkkhmoaggllfbokfghdopkejehckigl`；host manifest 仅注册在该 profile。
- `splitRatio.enabled=true` 仅存在于隔离 profile 的扩展存储；日常扩展未改动。
- 证据日志：固定 3:7 轮次 `acceptance-2026-10-18.jsonl`；保留比例轮次 `acceptance-preserve-2026-10-18.log`、`failure-swap-2026-10-18.log`；审查修复后复验 `acceptance-preserve-fix-2026-10-18.log`；业务站点焦点 smoke `business-focus-2026-10-18.log`、`business-ratio-focus-2026-10-18.log`。
- helper 当前安装路径 `~/Library/Application Support/TabOutRemote/tab-out-split-ratio`（仓库构建输出 `native/macos/build/tab-out-split-ratio`），SHA256 `adc19bfb23b59523b51d498fbea59f5ee8502508baf52b78cf719b0b29c39696`。

## 真实操作与实测数值

驱动创建 1 个总览与两个本地真标签 A/B（各含一个 textarea），分屏由真实 `chrome.tabs.createSplit` 建立。标记通过 LCU 直接键入当前聚焦元素，不点击、不脚本 focus 输入框。

| 操作 | 总览侧 | 总览数 | 实测宽度（总览/浏览） | 总览占比 | AX 焦点 | 键入标记后草稿 |
| --- | --- | --- | --- | --- | --- | --- |
| 初始 | 左 | 1 | 672 / 671 | 0.50037 | 浏览侧输入框 | `draft-A-` |
| 总览中鼠标点击 B | 左 | 1 | 403 / 940 | 0.30007 | B 原输入框 | `draft-B-MARKCLICK` |
| 遥控返回 | 左 | 1 | 403 / 940 | 0.30007 | A 原输入框 | `draft-A-MARKBACK` |
| 总览移到右侧后遥控确定 | 右 | 1 | 403 / 940 | 0.30007 | A 原输入框 | `draft-A-MARKBACKMARKRIGHT` |
| 窗口缩放到 1200×750 后确定 | 右 | 1 | 346 / 808 | 0.29983 | A 原输入框 | `draft-A-MARKBACKMARKRIGHTMARKRESIZE` |
| 菜单回总览 | 右 | 1 | 346 / 808 | 0.29983 | 总览 | 草稿保持 |

说明：`right` 重建分屏后未经比例校正时为 0.22919（413/1389，重建瞬间口径），随后「确定」由辅助程序拖动到 0.30007，证明拖动而非仅校验。所有 `check` 项同时校验了标记存在、`document.hasFocus()`、`activeElement === textarea`、总览数 1、占比误差 ≤0.02，全部 PASS。菜单未创建第二个总览，也未改变比例。

## 真实 Chrome 失败边界（2026-10-18 补充）

仅切换隔离 profile 的 host manifest（真实 helper / 指向对照 stub / 移除），每次重新启动同一隔离 Chrome 与扩展副本。失败场景统一从「总览 + A 已 50:50 分屏」开始，通过总览鼠标点击 B 触发真实选择与 Native 调用。

| 场景 | 注入方式 | 选择 B 后真实布局 | 总览数 | AX 焦点 | 界面提示 |
| --- | --- | --- | --- | --- | --- |
| host 缺失 | 移除隔离 profile 的 host manifest；启动健康检查返回 `Specified native messaging host not found.` | 伙伴 B 保留，splitViewId 由新的重组值 1056716896 取代原值，比例 0.50037 未变 | 1 | B 的 textarea（hasFocus + activeElement） | 显示「标签已切换，但未能固定 3:7 比例。请检查辅助程序、辅助功能授权及当前窗口。」（当时固定比例版本的文案） |
| 坏响应 | manifest 指向只回错误 `requestId` 的 stub，扩展判定 invalid-response | 同上：伙伴 B 保留、比例 0.50037 未变 | 1 | B 的 textarea | 同上 |
| 超时 | manifest 指向读取请求后不回包的 stub，扩展按自身 8s 上限失败 | 同上：伙伴 B 保留、比例 0.50037 未变 | 1 | B 的 textarea | 同上 |
| 权限不足 | manifest 指向始终返回 `{status:"permission-required",reason:"accessibility"}` 的 stub | 同上：伙伴 B 保留、比例 0.50037 未变 | 1 | B 的 textarea | 同上 |
| 重复伙伴 | 真实 helper；对当前伙伴再次「确定」 | 同一 splitViewId 保持，比例 0.29933 不变，无额外总览 | 1 | 伙伴 textarea 保持焦点 | 无错误 |

结论：四类 Native 失败都只产生提示，不触发 split-navigation 的布局回滚；已完成的真实标签切换保留，原浏览侧输入焦点仍恢复。失败后把 manifest 恢复为真实 helper，健康检查重新为 `already-correct`，重复伙伴场景确认拖动与焦点路径仍然正常。

测试注入物（`work/native-ratio-integration/fake-hosts/`、`set-host.sh`、`run-failure-scenario.sh`、`business.cjs`）只在本地验收目录，未进入仓库，也未改动日常 Chrome 或全局注册。证据：`failure-{missing,invalid,timeout,permission}.jsonl`、`dup-partner-2026-10-18.jsonl`。

## 2026-10-18 第二轮：保留用户实测比例（替代固定 3:7）

用户确认不需要固定 3:7，只要切换后保持自己拖好的总览宽度。实现与验证如下。

### 实现变更

- 协议 `set-split-ratio` 新增必填 `targetRatio`，范围 0.20–0.60；host 在总览在左时取 target，在右时取 1−target。
- 扩展在拆/建分屏前测量当前总览占比，夹取到范围内后传入；拖动后仍用真实宽度复核误差 ≤0.02。
- 选择与返回两条路径都先测量再重组；测不到稳定比例时跳过原生调用，保持默认均分。
- 失败提示改为「标签已切换，但未能恢复原分屏比例」。

### 真实 Chrome 数值

隔离 Chrome for Testing 155.0.8059.84；helper SHA256 `bb01e2bf…c71f12ce`，通过新路径 `native/macos/build/tab-out-split-ratio-preserve` 注册。初始非均分比例用同一 helper 的 `probe <ratio>` 直接协议设置（等价于手动拖好），再用真实总览/遥控路径切换。

| 操作 | 总览侧 | 实测宽度（总览/浏览） | 总览占比 | 总览数 | DOM 焦点 |
| --- | --- | --- | --- | --- | --- |
| 设置 0.42 | 左 | 564 / 780 | 0.41964 | 1 | 浏览侧输入框 |
| 鼠标点击 B（重建分屏） | 左 | 564 / 780 | 0.41964 | 1 | B 输入框 |
| 遥控返回 | 左 | 564 / 780 | 0.41964 | 1 | A 输入框 |
| 设置 0.56 | 右 | 753 / 591 | 0.56027 | 1 | A 输入框 |
| 鼠标点击 B（重建分屏） | 右 | 753 / 591 | 0.56027 | 1 | B 输入框 |
| 遥控返回 | 右 | 753 / 591 | 0.56027 | 1 | A 输入框 |
| 设置 0.90 / 0.19 | 右 | 不变 | 0.56027 | 1 | 拒绝 invalid-request |

干净序列复验（审查修复后）：`probe 0.38` → 切换 B（重建分屏）0.38021 → 返回 A 仍 0.38021，无错误提示；证据 `ratio-restore-2026-10-18.log`。

失败回归（target 0.42）：切换前把 manifest 换成缺失或错误 requestId 的 stub，再真实点击目标标签。重建后的分屏保留新伙伴、比例回到 0.5、总览数 1、输入框仍有焦点，界面显示新的失败提示；没有布局回滚。

### TCC 重新登记的坑（本轮实测）

重建 helper 后 CDHash 由 `ab6e0c5b…` 变为 `aa692ebc…`。在系统设置里移除后重新添加**同一路径**，系统日志仍显示记录绑定旧 CDHash（`Failed to match existing code requirement`，stored `ab6e0c5b…` vs current `aa692ebc…`），因此健康检查继续 `permission-required`。改为把新二进制复制到新路径 `build/tab-out-split-ratio-preserve` 并只做「添加」，新记录绑定当前 CDHash，健康检查恢复 `already-correct`。结论：ad-hoc 签名的 helper 重建后，若同路径重新授权不生效，换新文件名注册；不要删除 TCC 数据库或重置其他授权。

### 本轮测试

JS 全套 **68/68**（保留 0.42、范围夹取、按目标比例 already-correct、错误比例复核、右侧保持，以及审查修复新增的「无比例跳过」与「焦点恢复」）；native 协议 **20/20**（targetRatio 必填、边界与类型、合法边界）；身份/握手守卫 **15 + 15** 通过；`git diff --check` 通过。

### 本轮限制

- 手动拖动分隔条没有自动化；初始 0.42 / 0.56 由同一 helper 的协议设置，等价于用户拖好后的状态。
- LCU 本轮不可用（computer-use 内核超时），焦点以页面 `document.hasFocus()` / `activeElement` 判断，没有再次用 LCU 真实键入。
- 固定 3:7 轮次的旧 helper 路径仍在磁盘；隔离 profile 的 manifest 现指向 `-preserve`。
- 业务站点（Muse/Hark）仍未验收。

推荐把 helper 固定为新的 `-preserve` 路径并在每次重建后按上述方式重新登记。

## 自动化复跑

2026-10-18 首轮复跑：JS 全套 **61/61**（需要 `NODE_PATH` 指向 Playwright、`TAB_OUT_CHROME_PATH` 指向 Chrome 155+；缺任一项时浏览器测试文件会失败）（`work/native-ratio-integration/js-tests-2026-10-18.log`）；native 协议 **17/17**；身份/握手守卫 **9 + 15** 项通过（均不执行 GUI）；`git diff --check` 通过。源码本轮未改动，复跑用于确认验收环境与现有实现一致。

## 未被本轮覆盖 / 实际边界

- 业务站点（Muse/Hark）登录后的真实聊天框验收仍推迟；已补充未登录的登录页/落地页输入框焦点 smoke（见上节），它不是业务聊天框验收。
- 权限不足分支用返回该状态的对照 stub 验证扩展分流；本轮没有再次关闭系统辅助功能开关去复现真实 TCC 拒绝，前一轮已观测到真实 `permission-required` 健康响应并在重新登记后消失。
- 「host 启动瞬间用户已切到同窗口另一组分屏」的竞态未在真实 Chrome 中复现；该路径由身份/握手守卫断言与 JS 竞态测试覆盖。
- 失败边界在本地 textarea 页面验证；未在业务站点页面重复全部失败注入。
- 辅助程序只接受 0.20–0.60 的有界目标比例，协议仍只有 `status`/`set-split-ratio`/commit，没有任意比例、PID、键盘或窗口缩放接口。
- 本机再次重建 helper 后可能需要重复 TCC 重新登记；验证应以 Chrome 中真实健康响应为准，不能只看系统设置开关的 UI 状态。
- 隔离 profile 的 service worker 脚本缓存清理是测试环境行为；日常安装的扩展升级由 Chrome 正常更新流程处理。

## 日常 Chrome code_sign_clone 兼容修复（2026-10-18）

日常 Chrome 在自动更新后可能从 macOS 的 code-sign clone 路径运行主进程：

```text
/private/var/folders/.../X/com.google.Chrome.code_sign_clone/code_sign_clone.*/Google Chrome.app.bundle/Contents/MacOS/Google Chrome
```

而 `NSRunningApplication` 仍报告安装路径 `/Applications/Google Chrome.app`。helper 原来的父进程校验直接比较 `proc_pidpath` 与安装路径，导致日常 Chrome 下返回 `refused`（`untrusted-parent`）；Chrome for Testing 没有 clone，所以隔离验收未暴露。系统日志确认 helper 未走到辅助功能检查，诊断程序记录了上述父进程身份。

修复：`acceptableParentPath` 额外接受「同一 bundle id 的 code_sign clone 布局」——clone 标记包含 `<bundle id>.code_sign_clone`、目录以 `<App>.app.bundle` 结尾、可执行文件名与 `CFBundleExecutable` 一致；正常安装路径比较保持不变。守卫生成 15 identity + 15 handshake 断言，包含接受/拒绝 clone 的用例。

新 helper（clone 兼容）：`native/macos/build/tab-out-split-ratio-clonefix`，SHA256 `947188234aa9b2857ac8989d4afd7459615457ce7b922f0865174b7cd9dd92a5`（后被提速版替换）；隔离环境重新登记 TCC 后健康检查 `already-correct`，`probe 0.42 → 切换 B → 返回` 均保持 0.41964（证据 `clonefix-acceptance-2026-10-18.log`）。日常 Chrome 的 options「检查辅助程序」已显示「辅助程序连接正常，辅助功能已授权」。

## 扩展侧提速（2026-10-18，无需重建 helper）

- `measureRatio` 从「两次采样 + 80ms 间隔」改为「一次读取 + 宽度无效时才 50ms 重试」，省掉约 150ms。
- native 模块的稳定检测等待从 100ms 降到 60ms（仍最多 9 次），省掉约 80ms。
- 隔离实测干净序列：50:50 切换 0.656s → **0.455s**；重建+拖动 1.079s → **0.889s**；返回 1.082s → **0.870s**；比例保持 0.41964。证据 `extension-optimized-acceptance-2026-10-18.log`。
- 这两项只改扩展代码，不需要重建 helper 或重新登记 TCC；日常扩展目录已同步。

## 拖动提速（2026-10-18）

原拖动循环每步都做完整 AX 身份遍历（标签组 + 分隔条 + 窗口），20 步累积约 1 秒。优化：

- 每步只做轻量检查（截止时间、前台 App、窗口几何、焦点窗口）；完整身份遍历保留在 mouse-down 前和 commit 后。
- 步数 20→16，每步 10ms→8ms；mouseMoved 30→20ms、mouseDown 60→40ms；清除 Apple 事件抑制间隔。
- 隔离 Chrome 实测（同一 0.42 保持流程）：probe 1.070s → **0.655s**；鼠标切换 1.568s → **1.079s**；返回 1.481s → **1.082s**。比例仍保持 0.42039。证据 `fast-acceptance-2026-10-18.log`。
- helper 必须放在非受 TCC 保护的目录：放到 `~/Documents` 下会触发「访问文稿文件夹」弹窗，第一次启动可能阻塞到超时。现安装在 `~/Library/Application Support/TabOutRemote/tab-out-split-ratio`。
- 日常 Chrome 用户确认（2026-10-18）：options「检查辅助程序」连接正常，实际切换比提速前快，分屏比例保持。

## 业务站点焦点 smoke 验收（2026-10-18，未登录）

用户要求不登录，只验证真实站点已有输入框的焦点保持。方法：隔离 Chrome for Testing 155 加载当前扩展副本，打开真实 `hark.com` 登录页与 `muse.ai` 落地页（均未登录）；用真实鼠标点击一次输入框建立焦点，再通过总览鼠标选择/遥控返回切换分屏。**`document.hasFocus()` 在 Chrome 分屏里两个页面都报 true，不能作为焦点证据**，以 `document.activeElement` 的 tag/placeholder/editable 为准。

| 场景 | 切换前 | 切换/返回后 | 比例 |
| --- | --- | --- | --- |
| Hark 登录页「手机号码或电子邮箱地址」 | INPUT，editable | 切换到 Muse 再返回：仍为 INPUT，editable | 0.5 |
| Muse 落地页「手机号或邮箱」 | INPUT，editable | 切换到 Hark 再返回：仍为 INPUT，editable | 0.5 |
| Hark 登录页 + 非均分 | INPUT，editable；`probe 0.42` → 0.42039 | 选择 Muse 再返回：仍为 INPUT，editable；比例 0.42039 | 0.42039 |

范围与限制：只验证登录页/落地页的普通输入框焦点，不是登录后的业务聊天框验收；Muse 消息框适配没有被真正触发（页面原本已有可编辑焦点，适配逻辑保留焦点）；没有输入、发送或提交任何内容，也没有登录。证据：`business-focus-2026-10-18.log`、`business-ratio-focus-2026-10-18.log`。

## 审查修复（2026-10-18，两轴审查后）

- 测不到稳定比例时不再回退 0.30：`targetOf` 返回 null，`apply` 直接 skipped，首次组合保持 Chrome 默认均分。
- 预测量改为两次采样、间隔 80ms、宽度差 ≤1 才算稳定，最多 3 次。
- 原生结束后在安全条件下同时恢复目标标签激活与窗口焦点（`tabs.update` + `windows.update(focused)`）。
- settings 页复用 `native-ratio.js` 导出的 host/setting，去掉重复字面量；ADR 由 0002 改为 0004；`CONTEXT.md` 补充比例保持/目标比例/总览占比/辅助程序。
- 复跑：JS **68/68**、native 协议 **20/20**、守卫 15+15。

## 驱动改动（仅本地验收目录，未进仓库）

`work/native-ratio-integration/local.cjs` 为复现与定位增加了：启动时清理隔离 profile 的 `Default/Service Worker`、副本注入 `__nativeRatioError` 诊断钩子、`diag/probe/applycheck/applydebug/applypage/modulecheck` 诊断命令、`resize` 先退出 maximized 再设尺寸。驱动仍只通过真实分屏/真实扩展链路触发拖动，没有在驱动里替代执行鼠标拖动。

失败边界补充了 `business.cjs`（业务站点启动与命令入口，本轮未用它做站点验收）、`fake-hosts/*.py`（对照 Native host stub）、`set-host.sh`（只切隔离 profile 的 manifest）与 `run-failure-scenario.sh`；全部在验收目录，不进入仓库。
