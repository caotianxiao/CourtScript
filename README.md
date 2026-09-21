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

submit 模式只点击一次“确认预约”并监控 `/reservation/site/resource/launch`；新页面若使用其他请求通道，会转到“我的预约”核验结果。结果不明确时停止，绝不盲目重试。

## 一次性准点预约

先创建计划，再安装一次性任务：

```bash
courtscript plan add --date 2026-09-23 --slot 20:00-21:00
courtscript schedule-once --plan <id> \
  --at 2026-09-21T07:00:00+08:00 --prepare-minutes 5
```

任务在 06:55 启动普通独立 Edge，从 eHall 完成预登录，并由 `caffeinate` 保持 Mac 和网络唤醒。到 07:00:00 后，Edge 刷新资源页、重新核验目标格并只点击一次“确认预约”。如果机器在指定时刻后超过 120 秒才恢复，任务会放弃，不会迟到补抢。任务结束后会删除自己的 LaunchAgent 文件并卸载。

`launchd` 本身不能唤醒已经睡眠的 Mac。需要另行添加一次性 `pmset schedule wakeorpoweron` 事件，并确保届时仍处于已登录的用户会话；CourtScript 不会保存 Mac 管理员密码。

## 浏览器流程

主流程从 `ehall.fudan.edu.cn` 开始，全程使用独立 profile 的普通 Microsoft Edge，并通过 Edge 内置的 Apple Events JavaScript 接口完成页面读取和点击。这样既避免预约站在 WebDriver 下出现空白页，也避免 eHall 登录按钮在 WebDriver 中失效。脚本只在 `id.fudan.edu.cn` 登录表单中填入保存的凭据；遇到验证码或滑块会停止，不会尝试绕过。

独立 profile、凭据元数据、计划、日志和截图全部位于 `.state/`，该目录不会进入 Git。
