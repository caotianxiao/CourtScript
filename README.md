# CourtScript

复旦大学新场馆预约系统的本地预约脚本。脚本只处理主资源 `1055`，按参数给出的首选、备选时段顺序尝试，不选择或猜测具体场号。

## 初始化

```bash
cd /Users/caotianxiao/CourtScript
npm install
npm run build
npm link
courtscript auth save-credentials
```

账号只保存在权限为 `0600` 的 `.state/credentials.json` 中；密码由 macOS 钥匙串保存，服务名为 `CourtScript Fudan eHall`。重新保存凭据会覆盖旧值：

```bash
courtscript auth save-credentials
courtscript auth clear-credentials
```

## 创建与检查计划

```bash
courtscript plan add --date 2026-09-21 --slot 08:00-09:00 \
  --fallback 09:00-10:00 --fallback 12:00-13:00
courtscript plan list
```

`.state/plans.json` 保存计划、按优先级排列的时段、尝试记录和最终结果。

### 两个时段分别预约

如果两个时段都要预约、但必须优先抢其中一个，创建串行优先级计划：

```bash
courtscript plan add-priority --date 2026-09-23 \
  --high-slot 20:00-21:00 --low-slot 08:00-09:00
```

两个优先级也可以使用不同日期：

```bash
courtscript plan add-priority \
  --high-date 2026-09-23 --high-slot 08:00-09:00 \
  --low-date 2026-09-22 --low-slot 08:00-09:00
```

这与普通计划的 `--fallback` 不同：`--fallback` 最多成功预约一个时段；串行优先级计划会先独立提交高优先级时段，高优先级成功或失败后，再从 eHall 重新开始并独立提交低优先级时段。

## 运行

先执行 dry-run：

```bash
courtscript run --plan <id> --dry-run
```

dry-run 会从 eHall 登录，以同一独立 profile 打开普通 Edge，选择目标格并二次核验日期、时段和预填手机号，在“确认预约”前停止。成功时输出 `READY_TO_SUBMIT`，保存权限为 `0600` 的日志与截图，确认预约接口调用数必须为 `0`，随后刷新页面清除选择。

只有在现场确认计划、日期和时段无误后才运行：

```bash
courtscript run --plan <id> --submit
```

submit 模式不截图，核验完日期和时段后立即点击一次“确认预约”，并监控 `/reservation/site/resource/launch`；新页面若使用其他请求通道，会转到“我的预约”核验结果。结果不明确时停止，绝不盲目重试。

## 一次性准点预约

先创建计划，再安装一次性任务：

```bash
courtscript plan add --date 2026-09-23 --slot 20:00-21:00
courtscript schedule-once --plan <id> \
  --at 2026-09-21T07:00:00+08:00 --prepare-minutes 5
```

任务在 06:55 启动普通独立 Edge，从 eHall 完成预登录，并由 `caffeinate` 保持 Mac 和网络唤醒。到 07:00:00 后，Edge 刷新资源页、重新核验目标格并只点击一次“确认预约”。如果机器在指定时刻后超过 120 秒才恢复，任务会放弃，不会迟到补抢。任务结束后会删除自己的 LaunchAgent 文件并卸载。

`launchd` 本身不能唤醒已经睡眠的 Mac。需要另行添加一次性 `pmset schedule wakeorpoweron` 事件，并确保届时仍处于已登录的用户会话；CourtScript 不会保存 Mac 管理员密码。

## 两阶段优先级准点预约

在 06:57 启动登录、07:00 先抢高优先级时段，随后立即预约低优先级时段：

```bash
courtscript schedule-priority --pair <id> \
  --at 2026-09-21T07:00:00+08:00 --prepare-minutes 3
```

执行顺序固定为：

1. 06:57 从 eHall 登录并预热资源页；
2. 07:00:00 刷新并只提交一次高优先级时段；
3. 高优先级点击确认后仅保留 500ms 请求派发缓冲，不截图、不进入“我的预约”核验；
4. 关闭该独立 Edge 流程，立即从 eHall 重新进入；
5. 不再等待时间点，核验并只提交一次低优先级时段；
6. 两个抢场动作结束后，再补做高优先级的“我的预约”核验。

两个子计划分别保存结果。若某个子计划已成功，重新运行时会跳过它；若此前已经发出请求但结果不明确，也会禁止自动重试。原有的 `plan add`、`run` 和 `schedule-once` 行为不变。

## 浏览器流程

主流程从 `ehall.fudan.edu.cn` 开始，全程使用独立 profile 的普通 Microsoft Edge，并通过 Edge 内置的 Apple Events JavaScript 接口完成页面读取和点击。这样既避免预约站在 WebDriver 下出现空白页，也避免 eHall 登录按钮在 WebDriver 中失效。脚本只在 `id.fudan.edu.cn` 登录表单中填入保存的凭据；遇到验证码或滑块会停止，不会尝试绕过。

独立 profile、凭据元数据、计划、日志和截图全部位于 `.state/`，该目录不会进入 Git。

## 双 Edge 正式双提交

两个时段都要抢时，可以让两个隔离的普通 Edge 并发登录、同时刷新，并让 B 相对 A
错峰 150 ms 各提交一次。先做不提交验证：

```bash
courtscript run-parallel --date 2026-09-24 \
  --slot-a 08:00-09:00 --slot-b 09:00-10:00 \
  --dry-run --seed-profile
```

正式安装一次性任务：

```bash
courtscript schedule-parallel --date 2026-09-25 \
  --slot-a 20:00-21:00 --slot-b 21:00-22:30 \
  --at 2026-09-23T07:00:00+08:00 \
  --prepare-minutes 2 --submit-delay-ms 150
```

任务在 06:58 克隆已经验证的专用登录 profile，启动两个互相隔离的普通 Edge 并从
eHall 完成登录。07:00 前不检查尚未释放的目标格；到点后两路同时刷新，分别确认精确
日期、时段、“可预约”和可点击状态，再让 A 单次提交、B 延迟 150 ms 单次提交。任何
一路都不会回退时段或自动重试预约请求。两笔请求结束后统一进入“我的预约”核验，结果
写入权限为 `0600` 的 `.state/logs/parallel-*.json`。如果启动晚于目标时刻 120 秒，任务
安全停止。一次性任务结束后自动卸载并删除自身 plist 与 runner。

两路在刷新后独立判断、独立失败：若一个目标时段已经不可预约，另一个仍会继续选择并
单次提交，不再因联动保护被放弃。日志中的 `availableAfterRefresh`、`selectedLanes` 和
`submittedLanes` 分别记录两路状态；只成功一路时总状态为 `partial`。

刷新后的加载也完全独立：每个 Edge 在自己的预约表稳定后立即检查、选择并提交，不再
等待另一边加载完成。A 选择后立即提交；B 仍在自己的选择完成后保留 150 ms 配置延迟，
因此实际两笔提交间隔还会叠加两边页面加载速度的差异。

对已经开放的日期做定时全真测试时，须显式加 `--simulation`；正常正式预约会校验
`--at` 的上海日期必须是目标日期前两天。

与其他调度一样，`launchd` 不能唤醒已经睡眠的 Mac，正式使用前仍需设置 06:55 的
`pmset wakeorpoweron` 或确保电脑保持唤醒并登录。

## 双 Edge 并发实验命令

保留底层实验命令用于诊断，默认只选择、不提交：

```bash
courtscript parallel-feasibility --date 2026-09-24 \
  --slot-a 08:00-09:00 --slot-b 09:00-10:00
```

命令会创建两套临时隔离 profile、启动两个普通 Edge 根进程、同时刷新并分别选中
两个时段，要求两边的预约提交请求数均为零，然后关闭进程并删除临时 profile。
只有在明确授权真实预约时才可附加 `--submit`；该模式严格使用两个指定时段，每路
最多提交一次，不会回退到其他时段。`--submit-delay-ms 150` 可让 B 相对 A 错峰提交，
`--seed-profile` 会从 CourtScript 专用登录 profile 创建两份仅用于本轮的临时副本。
实测同毫秒双提交只成功一笔，150 ms 错峰已连续两轮成功两笔；正式使用仍需考虑
07:00 高竞争环境与登录态稳定性。
实测结论和正式并发版本的约束见
[`docs/parallel-first-priority-feasibility.md`](docs/parallel-first-priority-feasibility.md)。
