# CourtScript

CourtScript 是用于复旦大学新版体育场馆预约系统的 macOS 本地脚本。目前固定预约羽毛球主资源 `1055`，使用普通 Microsoft Edge、eHall 和统一身份认证完成登录，不选择、推断或随机分配具体场号。

本仓库的正式流程是“双优先级串行预约”：07:00 准点先提交高优先级时段；高优先级请求完成或明确失败后，立即重新从 eHall 进入并提交低优先级时段。两个时段是两个独立预约，不是普通计划中的备选时段。

> 脚本会真实提交学校预约请求。首次换机部署必须先完成登录测试和 dry-run。网站出现验证码、滑块、登录失效或页面结构变化时，脚本会停止，不会绕过验证，也不会盲目重复提交。

## 1. 运行环境

必须满足：

- macOS，保持用户账户处于已登录状态；
- Microsoft Edge 安装在 `/Applications/Microsoft Edge.app`；
- Node.js 22 或更高版本；
- Git、npm，以及 macOS 自带的 `osascript`、`security`、`sqlite3`、`pmset`、`launchctl` 和 `caffeinate`；
- 系统时区设为“亚洲/上海”，日期与时间自动同步；
- 正式预约时 Mac 接通电源、保持开盖，只进入睡眠，不关机、不重启、不注销。

检查基础环境：

```bash
node --version
npm --version
git --version
test -x "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" && echo "Edge OK"
```

如果没有 Node.js，可先安装 Homebrew，再运行 `brew install node@22`；也可以使用 Node.js 官方安装包。安装后需确认 `node --version` 至少为 `v22`。

## 2. 下载和安装

```bash
git clone https://github.com/caotianxiao/CourtScript.git
cd CourtScript
npm ci
npm run typecheck
npm test
npm run build
npm link
courtscript --help
```

`npm link` 会把 `courtscript` 命令链接到当前仓库。脚本会自动确定仓库根目录，因此安装后可以在任意目录执行命令。更新代码时运行：

```bash
cd CourtScript
git pull
npm ci
npm run build
npm link
```

`dist/` 不上传 GitHub，换机后必须执行一次 `npm run build`。

## 3. macOS 权限与 Edge 初始化

第一次运行时，macOS 可能询问终端是否允许控制 Microsoft Edge。选择“允许”。也可以在下面的位置检查：

1. 打开“系统设置 → 隐私与安全性 → 自动化”；
2. 找到正在使用的终端（Terminal、iTerm 等）；
3. 允许它控制 Microsoft Edge；
4. dry-run 需要保存截图时，再在“屏幕与系统音频录制”中允许该终端。

CourtScript 会在仓库的 `.state/edge-profile/` 创建专用 Edge profile，并自动为该 profile 启用 `allow_javascript_apple_events`。不要把这个 profile 当作日常浏览器使用，也不要同时手动打开它。

建议先录入凭据，再让脚本从 eHall 完成首次登录：

```bash
courtscript auth save-credentials
courtscript auth login
courtscript auth check
```

`auth save-credentials` 会弹出两个系统对话框：

- 账号仅写入 `.state/credentials.json`，文件权限为 `0600`；
- 密码写入 macOS 钥匙串，服务名为 `CourtScript Fudan eHall`；
- 密码不会写入源码、日志或 GitHub。

密码变更后重新运行 `courtscript auth save-credentials` 即可覆盖。删除本机凭据：

```bash
courtscript auth clear-credentials
```

如果希望迁移日常 Edge 中已有的复旦登录态，可改用下面的初始化方式。运行前必须正常退出全部 Edge 窗口，而且日常 Edge 的活跃 profile 必须是 `Default`：

```bash
courtscript auth import-edge
courtscript auth check
```

`auth import-edge` 只保留 `fudan.edu.cn` 域名的 Cookie 和站点存储，临时完整副本会被删除。专用 profile 已存在时不要再次导入，直接使用 `auth login` 或 `auth check`。

## 4. 睡眠、亮屏和自动唤醒设置

正式任务默认在 06:55 安装一次性硬件唤醒、06:57 启动登录、07:00 提交。06:55–06:57 之间任务尚未启动，必须让系统闲置休眠时间长于这段空窗。

推荐在接通电源时设置为 15 分钟关闭屏幕、20 分钟系统休眠：

```bash
sudo pmset -c displaysleep 15 sleep 20
pmset -g custom
```

`displaysleep` 必须小于 `sleep`，否则 macOS 会显示 “Display sleep should have a lower timeout than system sleep” 警告。不要把接电模式的 `sleep` 设成 1 分钟。若也希望电池模式安全，可单独设置：

```bash
sudo pmset -b displaysleep 5 sleep 10
```

正式预约仍建议全程接通电源。06:57 任务启动后会通过 `caffeinate -dimsu` 持续阻止系统、显示器、磁盘和网络进入休眠，直到两次预约结束。

`schedule-priority` 默认自动执行一次：

```text
pmset schedule wakeorpoweron "MM/DD/YY 06:55:00"
```

macOS 会弹出管理员授权窗口，但管理员密码只交给系统授权对话框，CourtScript 不读取或保存。安装后可核对：

```bash
pmset -g sched
```

必须看到目标日期的 `wakeorpoweron`。硬件唤醒不能替代用户登录，因此正式任务前还要满足：

- Mac 处于睡眠状态，而不是关机或停在 FileVault 登录界面；
- 用户账户没有注销；锁屏可以，但建议不要启用闲置后自动注销；
- MacBook 保持开盖并接通电源；
- 不要在任务前拔掉电源，因为电池模式可能使用不同的休眠时间。

## 5. 首次 dry-run

用一个已经开放且仍有余量的日期建立测试计划：

```bash
courtscript plan add-priority \
  --date 2026-11-19 \
  --high-slot 21:00-22:30 \
  --low-slot 20:00-21:00
```

命令会输出一个八位 `id`，它是后续使用的 `<pair-id>`。执行不提交测试：

```bash
courtscript run-priority --pair <pair-id> --dry-run
```

dry-run 会依次完成登录、日期定位、时段选择和预约信息核验，在“确认预约”前停止。请求监控必须确认真实 `/site/resource/launch` 请求数为 0。截图和脱敏日志保存在 `.state/screenshots/` 与 `.state/logs/`。

只有 dry-run 成功，并确认日期、两个时段和手机号预填信息正确后，才设置正式任务。

## 6. 正式双优先级预约

学校通常在目标日期前两天的北京时间 07:00 释放资源。例如要在 2026-11-19 预约，正式提交时刻应为 2026-11-17 07:00：

```bash
courtscript plan add-priority \
  --date 2026-11-19 \
  --high-slot 21:00-22:30 \
  --low-slot 20:00-21:00

courtscript schedule-priority \
  --pair <pair-id> \
  --at 2026-11-17T07:00:00+08:00 \
  --prepare-minutes 3 \
  --wake-minutes-before 5
```

必须在 06:55 之前安装任务。`--at` 必须包含 `+08:00`，脚本还会校验调度日期是否确实是高优先级目标日期的前两天。

默认执行顺序：

1. 06:55 通过 `pmset` 唤醒 Mac；
2. 06:57 LaunchAgent 启动，`caffeinate` 接管防休眠，并从 eHall 登录、预热资源页；
3. 07:00:00 刷新资源表，重新查找目标日期列和高优先级时段，只点击一次“确认预约”；
4. 保持当前 Edge 存活直到提交请求取得完整响应；已观察到 pending 请求时最长等待 60 秒，不会提前关闭浏览器；
5. 不在两个优先级之间进入“我的预约”核验，直接关闭本轮窗口并从 eHall 开始低优先级；
6. 如果高优先级异常地在 07:00 前结束，低优先级继承同一个 07:00 时间屏障；如果已经过 07:00，则立即执行；
7. 两个抢场动作结束后，才补做高优先级的“我的预约”核验并写入最终结果。

正式 submit 模式不截图。每个时段最多发送一次预约请求；请求已经发出但结果不明确时，脚本会标记为 `ambiguous` 并禁止自动重试。

如果电脑确定整晚不会睡眠，可以显式加 `--no-wake`，否则不要使用该选项。

## 7. 检查任务与结果

安装成功后，命令会输出 LaunchAgent 标签和绝对日志路径。也可以检查：

```bash
courtscript plan list
pmset -g sched
launchctl print "gui/$(id -u)/cn.edu.fudan.courtscript.priority.<pair-id>"
```

任务结束后查看日志：

```bash
cat .state/scheduler/cn.edu.fudan.courtscript.priority.<pair-id>.log
courtscript plan list
```

一次性 LaunchAgent 在运行结束后会删除自己的 plist 和 runner 并卸载，因此事后 `launchctl print` 找不到它是正常现象。计划、尝试记录和结果保存在 `.state/plans.json`。

## 8. 普通首选/备选计划

普通计划只会成功预约一个时段，按首选和备选顺序尝试：

```bash
courtscript plan add \
  --date 2026-11-19 \
  --slot 21:00-22:30 \
  --fallback 20:00-21:00

courtscript run --plan <plan-id> --dry-run
courtscript run --plan <plan-id> --submit
```

它与双优先级计划不同：`--fallback` 是“首选失败才改约备选”，最多得到一个预约；`add-priority` 会分别提交两个指定时段。

## 9. 双 Edge 并发模式

仓库同时保留两个隔离 Edge 错峰提交两个时段的实验/正式实现。建议先使用稳定的串行双优先级模式；确实需要并发时，先做 dry-run：

```bash
courtscript run-parallel \
  --date 2026-11-19 \
  --slot-a 20:00-21:00 \
  --slot-b 21:00-22:30 \
  --dry-run --seed-profile
```

正式调度示例：

```bash
courtscript schedule-parallel \
  --date 2026-11-19 \
  --slot-a 20:00-21:00 \
  --slot-b 21:00-22:30 \
  --at 2026-11-17T07:00:00+08:00 \
  --prepare-minutes 2 \
  --submit-delay-ms 150
```

并发模式不会自动安装硬件唤醒，必须另行保证 Mac 已唤醒。实现约束和历史实验记录见 [`docs/parallel-first-priority-feasibility.md`](docs/parallel-first-priority-feasibility.md)。

## 10. 常见问题

### Apple Events 被拒绝

先退出专用 Edge，再运行：

```bash
courtscript auth login
```

留在电脑前接受 macOS 的“终端控制 Microsoft Edge”授权，然后重新执行 `auth check`。不要等到正式预约时才首次触发权限弹窗。

### 统一身份认证失败

重新录入账号密码：

```bash
courtscript auth save-credentials
courtscript auth login
```

如果出现验证码或滑块，只能人工处理；脚本会安全停止。

### 唤醒后又休眠

检查当前是否接电，以及接电模式的 `sleep` 是否足够长：

```bash
pmset -g batt
pmset -g custom
pmset -g sched
```

推荐值是 `AC Power: displaysleep 15, sleep 20`。如果 `sleep` 仍是 1，06:55 唤醒后可能在 06:57 任务启动前再次休眠。

### 找不到目标日期

脚本会自动判断当前周、上一周或下一周并翻页。若学校改变“提前两天、07:00 开放”规则或预约页 DOM，先停止真实预约，重新执行 dry-run 并检查日志。

### Edge 安装位置不同

当前固定路径在 `src/constants.ts` 的 `EDGE_EXECUTABLE`。若 Edge 不在 `/Applications`，修改该常量后重新执行：

```bash
npm run build
npm link
```

## 11. 数据与安全边界

以下内容只保存在本机 `.state/`，并已被 `.gitignore` 排除：

- 统一身份认证账号元数据；
- 专用 Edge profile、Cookie 和站点存储；
- 预约计划、日志、截图和调度 runner；
- 本机运行结果和备份。

密码保存在 macOS 钥匙串，不位于 `.state/`。`node_modules/`、`dist/`、日志和 `.DS_Store` 也不会上传。提交或发布前可再次确认：

```bash
git status --short
git ls-files | grep -E '(^|/)(\.state|dist|node_modules)/' && echo "ERROR: sensitive path tracked"
```

正常情况下最后一条命令没有任何输出。

## 12. 开发验证

```bash
npm ci
npm run typecheck
npm test
npm run build
```

当前测试覆盖日期与上海时区、周翻页、时段选择重试、双优先级状态与时间屏障、Apple Events 只读探测重试、硬件唤醒时间和提交响应解释。
