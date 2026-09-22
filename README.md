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
