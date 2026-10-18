# macOS 原生比例辅助程序接入

2026-10-17。范围：本地实现和隔离验证。不得修改日常加载目录，不得推送。

## Ground

真实点击与遥控确定均在 remote-background 的串行命令队列调用 split.select；返回调用 split.cancel。split-navigation 完成真实标签移动、分屏重建及返回会话管理。Muse 适配目前在标签激活后执行。Native failure 必须位于 split-navigation 的布局回滚事务之外。

## Sketch / agree

候选 A 是单次 sendNativeMessage，无常驻进程。候选 B 是 connectNative 连接与单在途请求管理器。首轮选择 A；代码复核证明，仅在原生捕获后核对同一分屏，不能防止 host 启动期间用户已换到同窗口的另一组分屏。因此最终吸收 B 的连接机制，改为每次操作独立的短连接，分为 prepare、扩展重新核验并 commit、原生调整三个阶段；结束即断开，没有常驻服务、自动重放或重连。技能默认 Claude/Grok 模型不可用，设计与评审使用当前支持的继承模型。

数据归属：扩展拥有标签、分屏和窗口身份；辅助程序拥有原生窗口匹配、分隔条几何和鼠标操作。公开接口 createNativeRatio(api).apply(dashboardId, targetId, targetRatio) 隐藏传输与布局验证；返回有限状态，调用者只处理可见提示。设置 splitRatio.enabled 默认 false，通过选项开启。扩展在拆/建分屏前测出用户拖好的总览占比，限制在 0.20–0.60 后作为目标比例传给 host；不暴露任意比例或任意命令，也不在 host 端读取网页内容。首次新组合保持 Chrome 默认均分。

## Wire contract v2

Host name `com.tab_out_remote.split_ratio`。请求严格校验：

```json
{
  "version": 2,
  "requestId": "unique-id",
  "operation": "set-split-ratio",
  "expiresAt": 1792195200000,
  "overviewSide": "left",
  "viewportWidths": {"left": 677, "right": 677},
  "windowBounds": {"left": 0, "top": 25, "width": 1400, "height": 816},
  "targetRatio": 0.42
}
```

`targetRatio` 必填，范围 0.20–0.60，表示总览侧在可视宽度中的占比。扩展在拆开分屏前测量用户当前拖好的比例，夹取到该范围后传入；host 在 overviewSide 为 left 时取 targetRatio，为 right 时取 1−targetRatio。测不到稳定比例时跳过原生调用，保持 Chrome 当前布局；因此首次组合保持默认均分。expiresAt 是调用时生成的毫秒截止时间，示例数字不可复用。原生先捕获当前两个原生标签和分隔条，回复 `{version:2, requestId, status:"prepared", token}`，尚不移动鼠标。扩展再次读取原定标签、分屏、窗口、方向、宽度和前台状态，确认仍一致后才发送 `{version:2, requestId, operation:"commit-split-ratio", token}`；不一致则 abort/disconnect。host 收到 commit 后再次核对自己捕获的两个原生标签，才开始拖动。不可预测 token 在本次连接中只消费一次。

最终响应 `{version:2, requestId, status, reason?}`，status 为 adjusted / already-correct / permission-required / refused / error。原生返回 adjusted 只说明拖动结束；扩展必须核对真实标签宽度与 targetRatio 的误差不超过 0.02 才宣告比例成功。无鼠标操作的 `status` 健康检查继续使用 sendNativeMessage，但同样要求 version 2。

Native Messaging 使用原生字节序 uint32 长度前缀及 UTF-8 JSON。每帧上限 16 KiB，完整读取 apply 和 commit 两帧；健康检查只需一帧。stdout 只能写协议帧。host 总执行期限最多 6 秒，commit 等待最多 2 秒，扩展等待最多 8 秒；EOF、断开或超时前没有有效 commit 时不得产生鼠标事件。禁止在生产 host 保留原型中的 type、resize、任意 PID 或任意鼠标坐标接口。

## Runtime invariants

- host 从真实父进程取得浏览器身份，校验 Chrome/CfT 包标识与主程序（含 macOS code_sign_clone 的等价主程序路径）；不能扫描任意 Chrome 或相信消息指定的 PID。
- 只操作当前前台浏览器的前台 AX 窗口；请求边界与 AX 边界匹配、匹配唯一、分隔条唯一才允许拖动。不能读取页面输入内容或传递 URL/标题。
- host 自行限制最长执行期限，并在 mouse-down 前及每步拖动前检查截止、前台身份、窗口几何是否改变；一旦抢占或超时，停止移动并释放鼠标。
- JS 请求超时必须长于 host 自行执行期限。超时不等于撤销已发出的事件，不能用 JS timeout 作为唯一安全措施。
- 扩展在原生调用前后确认同一真实分屏、同一伙伴、同一窗口，等待稳定的正数宽度，再验证总览占比与目标比例误差不超过 0.02。
- host 失败不能触发布局回滚。若用户未切换窗口且分屏身份仍匹配，恢复目标标签激活和窗口焦点，最后运行 Muse 适配。用户已转到别的 App/窗口时不抢回焦点。
- 菜单复用已有总览，不为比例功能创建额外总览。非分屏路径维持原行为。

## Throughput checkpoint

1. Blocking first steps：冻结协议、核实临时 user-data-dir 的 NativeMessagingHosts 查找能力，才能进行真实 host 验证。
2. Independent workstreams：一个 feature owner 负责代码接入，并可在协议冻结后将 native/macos 与 extension/tests 分配给独立 owner。主线程负责隔离运行、LCU 与报告。
3. Shared mutable state：代码各文件单一 owner；原生与扩展通过此协议协作。用户窗口只能由当前串行切换流程操作。
4. Smallest safe decomposition：不建常驻服务或通用自动化框架。辅助程序只负责有界目标比例，测试工具和生产 host 分开。

## Verification / scrap

先验证真实 Native Messaging、单总览、左右布局、重复伙伴、返回、host 缺失/权限不足/坏响应/超时的失败边界，及原生协议边界。再用 LCU 在隔离 Muse、Hark 中验证无需点击输入框即可键入。隔离会话无法登录或页面无法访问时明确报告缺口，不用本地 textarea 代替业务网页验收。用户网站草稿不提交；测试标记清理且不发送。

NativeMessagingHosts 仅注册在本次隔离 profile。不得静默写到日常 Chrome 的用户级注册目录。登录会话留在仓库外的本地隔离 profile，不提交或复制个人 Chrome 凭据。
