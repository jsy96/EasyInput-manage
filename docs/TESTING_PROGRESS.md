# 测试进度

> 最近更新：2026-10-30（Asia/Shanghai）
> 保存说明：项目目录约定未建立 `flow/`，专题进展按 `AGENTS.md` 规则放入 `docs/`。本文件顶部一条为当前交接棒，向下为历史。

## 当前状态：固件 0.4.22 已烧录，网页 0.4.9 已部署（2026-10-30）

### 本轮实现

- 全部慢闪统一为亮 0.5 秒、灭 1.5 秒（周期 2 秒）；实体灯与网页动画同步调整，红灯仍为 1% 亮度，计时 1 Hz 仍为亮灭各 0.5 秒。
- 灯 5 读取设备 Wi-Fi 状态：连接／重试时慢闪，连接到路由器后常亮，未连接且无连接尝试时熄灭。没有配置、Wi-Fi 停止及暂停连接重新配置时熄灭；持续自动重试时保持慢闪。语音服务心跳和蓝牙网关不参与灯 5 判断，原语音连通判断保留。
- 相关源码、网页说明及协议文档同步；固件版本更新为 0.4.22，网页版本更新为 0.4.9，Git 发布标签为 `v0.4.22`。

### 已执行的检查与发布

- `npm test`：16 个测试文件、134 项测试全部通过。实际 C 函数测试覆盖五灯慢闪 0.5 秒亮／1.5 秒灭的边界、灯 5 未连接／连接中／重试／已连接／重新配置暂停状态，以及语音心跳变化不改变灯 5；原计时与灯光优先级测试继续通过。`npm run typecheck`、`npm run build`、`git diff --check` 通过。
- 复用 ESP-IDF 5.5.5 构建成功，应用镜像 2,603,584 字节（`0x27ba40`），应用分区 `0x3f0000`，余量约 37%。构建保留原有 `cJSON_InitHooks` const 参数警告，未扩展本次修改范围。
- 通过 `scripts/export-firmware.py --version 0.4.22` 导出至 `release/firmware/0.4.22-v2-monitor/`，三个镜像大小与 SHA-256、包版本及应用内嵌版本均已核验，历史固件包保留。构建目录、导出包与网页 `dist/` 不提交 Git。
- 烧录前及最终恢复前确认 ESP32-S3 MAC `14:C1:9F:39:7D:20` 匹配用户确认目标。自动进入下载模式并烧录成功，三个镜像哈希校验通过；仅写入 `0x0`、`0x8000`、`0x10000` 的 bootloader、分区表和应用，保留 NVS 与录音 outbox。
- 烧录后两阶段检查返回 `PRE_RESET_IDENTITY=matched`、`POST_FLASH_READY=yes`、`ROM_DOWNLOAD_MODE=no`。日志确认 App version `0.4.22`、ESP-IDF `v5.5.5` 及 `EasyInput monitor firmware started`，未见 panic、abort、栈异常、brownout 或 ROM 下载模式签名。
- 网页 0.4.9 通过 Workers Static Assets 部署至 `studio.leige.online`，部署版本 `ed4147f3-4200-433b-9708-84b8119ff9d8`。HTTP GET 校验线上首页、主 JS、CSS、manifest 和 `sw.js` 均与本地构建逐字节／SHA-256 一致，主 JS 确认版本 0.4.9 及新灯光说明，CSS 确认 2 秒慢闪周期。Python HTTP 核验曾遇到 403，改用 curl 后完成核验，没有修改线上访问策略。
- 云端网关本轮未改动、未部署。

### 验证范围与待验收项

本轮确认了自动化测试、完整固件及网页构建、设备烧录与新版本启动、网页发布及线上资源一致性。实体灯光节奏，以及 Wi-Fi 未配置、首次连接、连接成功、断线重试时的灯 5 表现仍需用户观察；没有为核验清除 Wi-Fi 配置或改变网络。原有按键、声音、闹钟跨重启保存及 S5/S6/S7 的待验收项仍保留，详见 [VOICE_CHAT.md](VOICE_CHAT.md#验证边界)。

## 历史状态：固件 0.4.21 已烧录，网页 0.4.8 已部署（2026-10-29）

### 本轮实现

- 保留 0.4.20 的 S8 独立正计时、五灯规则与闹钟旋律。闹钟设置／取消失败改播现有“失败”，真正录音保存失败仍提示保持供电。
- `timers_set_alarm_minute` 在 `nvs_open`、`nvs_set_u16`、`nvs_commit` 成功后才更新运行态和触发去重状态；各失败阶段记录错误名与错误码，失败保留原内存设置，不擦除 NVS 或推测性恢复。
- 清理 42 条无引用提示音，资源由 209 条减至 167 条，1,350,676 字节减至 986,582 字节。保留固定 ID、停用 ID 留空；167 条保留音频逐 ID SHA-256 均未变，不清理用户录音、历史记录或 outbox。

### 已执行的检查与发布

- `npm test`：16 个文件、130 项测试通过。覆盖实际 C 代码的闹钟 open／set／commit 失败、状态及触发去重保持、成功设置／取消持久化、提示选择，以及稀疏提示包的实际 C 读取、旧包迁移、复用与固定 ID 刷新。
- `npm run build` 成功，包含 `tsc --noEmit` 类型检查。
- ESP-IDF 5.5.5 构建成功，应用镜像 2,603,472 字节（`0x27b9d0`），应用分区 `0x3f0000`，余量约 37%。通过 `scripts/export-firmware.py --version 0.4.21` 导出至 `release/firmware/0.4.21-v2-monitor/`，三个镜像大小及 SHA-256 均与清单一致；历史包保留。
- 烧录前后确认原 ESP32-S3 身份 MAC `14:C1:9F:39:7D:20`，`PRE_RESET_IDENTITY` 匹配、`POST_FLASH_READY` 为 yes。烧录成功并通过三个镜像哈希校验，仅写入 `0x0`、`0x8000`、`0x10000` 的 bootloader、分区表和应用，未擦除 NVS 或录音 outbox。
- 烧录后日志明确显示 App version `0.4.21`、ESP-IDF `v5.5.5` 和 `EasyInput monitor firmware started`，未见 panic、abort、栈异常、brownout 或 ROM 下载模式签名。
- 通过 USB 只读请求 `hello.get`，收到固件 `0.4.21` 的 hello 与完整 status：NVS 状态 ready（438 条已用、318 条空闲），录音存储错误为 false、待发录音为 0；这不替代实际闹钟保存操作的验证。
- 网页 0.4.8 通过 Workers Static Assets 部署至 `studio.leige.online`，部署版本 `8766bd7d-63b2-4bdc-8ddd-0dc0b10a63e8`。使用 HTTP GET 对线上 `index.html`、主 JS、CSS、manifest 和 `sw.js` 逐字节／哈希核验，均与本地 `dist/` 一致，主 JS 确认版本 0.4.8。
- 网关本轮未改动、未部署，继续使用版本 `79e77ee8-cbe9-431f-a7d5-285e9037aabc`。

### 验证范围与待验收项

本轮确认了软件检查、固件烧录及正常启动、网页静态资源发布。实板按键、灯效、声音、闹钟跨重启保存及原有 S5/S6/S7 操作仍需用户验收。闹钟 NVS 保存失败的真实触发原因尚未确认；本次修正错误提示与运行态更新顺序，不能据此声称已解决 NVS 存储故障。完整清单见 [VOICE_CHAT.md](VOICE_CHAT.md#验证边界)。

## 历史状态：0.4.20 正计时与五灯规则完成软件验证及固件导出（2026-10-29）

### 本轮实现

- S8 松手开始／停止独立正计时，停止后播报总时长；采用按键事件时间与单调时钟，断网可用、重启归零，与倒计时并行。音频忙时按顺序延后播报，最多排队 8 条结果，满后拒绝新开始。
- 五灯统一红色 1% 亮度，分别表示接收／未读、闹钟／计时、录音／待发送、网页实时监听、语音服务连通状态。慢闪亮 0.5 秒灭 2 秒，计时亮灭各 0.5 秒；闹钟到点的灯 2 慢闪优先持续 1 分钟，声音忙时延后。
- 新增约 10 秒本地合成闹钟旋律及正计时语音，提示音包从 203 条增加到 209 条，原 203 条逐字节保留。
- 网页操作说明、状态显示、全部已读步骤、功能互斥和失败处理说明已同步；USB/BLE 完整状态新增 `voice.stopwatch_running` 与 `voice.stopwatch_seconds`，旧固件缺字段时不显示伪造数值。

### 已执行的软件检查

- `npm test`：15 个测试文件、128 项测试全部通过。覆盖真实 `timers.c` 的正计时边界、并行和重启归零，以及 S8 独立输入、延后播报队列、历史语音下载期间等待、灯光优先级／闪烁边界、服务心跳超时和已有功能回归。
- `npm run typecheck`、`npm run build` 成功。曾在本地页面检查新说明文字和窄屏换行；浏览器会话随后失效，未继续反复尝试，折叠交互和完整页面效果仍可人工核验。
- ESP-IDF 5.5.5 最终构建成功，应用镜像 2,967,360 字节（`0x2d4740`），应用分区余量约 28%。
- 固件已导出至 `release/firmware/0.4.20-v2-monitor/`；清单版本、三个镜像大小与 SHA-256 已校验，历史包保留。
- 提示音包生成成功，共 209 条、1,350,676 字节；闹钟音乐解码为 8 kHz 单声道音频，实际约 9.94 秒。解码检查不代表实板听感。

### 验证范围与待验收项

**该次 0.4.20 未烧录、未部署网页、未部署云端。** 当时仅更新源码、网页构建产物及导出包，旧版实测结果不作为 0.4.20 的验收依据；后续 0.4.21 的烧录与网页 0.4.8 部署结果见顶部当前状态。

实板仍需检查 S8 零秒／跨分钟／跨小时播报、多轮 FIFO 与 8 条上限、音频忙时补播、与各音频模式及倒计时并行；五灯实体顺序、亮度、节奏和覆盖优先级；闹钟音乐听感及延后播放；服务断连恢复；全部已读确认及原有 S5/S6/S7 功能。完整清单见 [VOICE_CHAT.md](VOICE_CHAT.md#验证边界)。

## 历史状态：S7 实时音频主链路已通，0.4.6 验收通过（2026-10-28）

以下按键含义、版本、测试数据及烧录方式均属于当时历史记录，当前操作以 [VOICE_CHAT.md](VOICE_CHAT.md) 为准。

### 已验收（0.4.6 实测，两轮 S7→说话→S8）

- S7 开始实时监听，网页能听到声音；S8 停止并语音提示“实时监听已结束”。
- 停止即时生效：S8 按下约 110~120 ms 内退出实时模式、关闭麦克风（优先级 4→5 修复了语音任务被音频锁饿死的问题）。
- 停止后麦克风确实关闭（标志位方式，由音频任务自行关停），可连续多轮 S7。
- 测试窗口内云端连接全程在线，无一次断线（cJSON/云消息分配迁移 PSRAM 后 `esp-aes` 内存分配失败消失）。
- 内部内存水位明显改善：空闲 ~24KB、历史最低 ~9.5KB（此前最低 16 字节）。

### 版本与包

- 0.4.6，固件 2152624 字节，包 `release/firmware/0.4.6-v2-monitor/`。
- 历史包 0.4.2 / 0.4.3 / 0.4.4 / 0.4.5 保留在 `release/firmware/`，未清理。
- 交互变更：实时中只有 S8 停止并语音提示，其他按键在实时中不再停止（`docs/VOICE_CHAT.md`、`README.md` 已同步）。

### 已知剩余（后续可选优化，非阻塞）

- 实时音频送达率约 50%~60%（发送侧 ~15~30 帧/秒），声音略碎；提升需改云端/网页的分包格式（一次多个 20ms 帧）。
- 云端极偶发（约 20 分钟量级）仍可能因 TLS 写入超时断连一次并自动重连，不影响基本使用。
- 板上无 RESET/EN：烧录用 esptool `--before default_reset --after hard_reset`（RTS 复位有效，无需短按 BOOT）。

## 历史交接：S7 实时音频 0.4.4 修复包（2026-10-28 第四轮）

### 已确认进展（0.4.3 实测）

- S7→网页出声→S1→红点关闭主链路已通：77/174 帧成功送达，断连不再由单帧发送失败触发。
- 遗留问题一：停止后语音任务永久卡在音频互斥量（stage=7，实测 4 分钟以上），麦克风不关、后续 S7 无响应。根因：音频任务活跃时持锁忙循环不休眠，同优先级等锁方饿死；0.4.3 给停麦克风加的 1 秒限时等待超时。
- 遗留问题二：空闲时每 20~40 秒 `esp-aes: Failed to allocate memory` → TLS 失败 → 云连接周期性断开（“设备总是离线”）。根因：内部内存仅剩 ~15KB 且被每秒 3KB 状态 JSON 碎片化，AES 临时分配失败。

### 0.4.4 已改（本包）

- `audio.c`：停麦克风改为置标志、由音频任务自行执行；调用方限时等待并有兜底路径，不再与采集循环抢锁。
- `main.c`：cJSON 全局分配钩子切到 PSRAM（状态 JSON 等全部走 PSRAM）。
- `cloud.c`：云消息解析/发送拷贝挪到 PSRAM。
- 版本 0.4.4，固件 2152608 字节，包在 `release/firmware/0.4.4-v2-monitor/`。

### 待办

- 烧录 0.4.4 后重测 S7→说话→S1：确认停止后麦克风关闭、stage 不再卡 7、可连续多次 S7。
- 长时间观察云连接是否还有周期性断线（重点看 `esp-aes` 报错是否消失、`ram_free` 水位）。
- 音频送达率（当前 ~45%）后续再优化。

## 历史交接：S7 实时音频诊断构建 0.4.2（2026-10-28 第二轮）

### 焦点

已确认板内实时音频“进队列但发不出去”的根因层：语音时间线任务在实时会话期间几乎完全卡死（三轮实测每轮只消费 0～1 帧，队列深度 4 塞满后每帧丢 2 个），顺带把 S1 停止延迟拖到 2.8～13 秒、并把内部内存耗尽到状态 JSON 打不出来。

### 本轮已做（已确认方案）

- `voice_chat.c`：实时音频发送拆到独立 `realtime_tx` 任务（优先级 6，PSRAM 栈），语音任务不再消费音频帧；音频队列深度 4→32 且放入 PSRAM；主循环加 `stage` 标记（1=循环顶、2=等信号量、3=按键、4=控制、5=probe、6=定时器、7/8=音频快照前后、9/10=提示音、11/12=超时与空闲分支、13/14=灯效与快照尾部）。
- `main.c`：麦克风 level 事件带 `stage/mode/ready/rt_wait`（麦克风活跃时每 250ms 一条，绕过状态 JSON 打不出的问题）；`emit_status` 建 JSON 失败时发 `status_mini`；状态 JSON 的 `voice.debug` 增加 `stage`。
- `voice_chat.h`：快照结构增加 `stage` 字段。
- 版本 0.4.1 → 0.4.2（`CMakeLists.txt`），编译通过，固件 2151856 字节。
- 固件包已导出：`release/firmware/0.4.2-v2-monitor/`（firmware.json、bootloader、分区表、应用镜像；SHA-256 见 firmware.json）。

### 待办

- 烧录 0.4.2（esptool 或 PWA“设备→固件升级”选 0.4.2 包；进下载模式需板子开机时短按 BOOT，恢复靠断电再开机）。
- 重测 S7→说话 2–5 秒→S1：观察 level 事件的 `stage`（定位语音任务卡点）、`q/cloud_sent_rt`（音频是否发出）、网页是否听到实时声音、S1 停止延迟。
- 若 stage 停在 7：卡在音频互斥量；停在 5：probe/发送路径；stage 持续推进则问题在别处。

## 历史交接：S7 实时音频与 S1 停止（2026-10-28 第一轮）

### 焦点

让 S7 的 16 kHz PCM16 实时音频低延迟、可被 S1 稳定停止，并让网页红点状态与实际一致。

### 当前现象（最新一轮）

- S1 按下已被输入扫描任务识别，但语音任务没有进入停止路径。
- 旧固件观测：`last_key=6`、`realtime_stops=0`，说明按键事件未到达语音状态机。
- 实时麦克风为 active，但 `realtime_sink_calls / realtime_sink_bytes` 为 0，音频没有进入实时发送回调。
- 云端连接建立阶段内部 RAM 最低只剩约 16 字节，作为风险持续跟踪。

### 本轮已做

- 部署新版 Cloudflare Worker，版本 `f00d3772-5cbb-4a68-87be-be4e12528f7f`，健康检查正常。
- Worker 侧：直连板断开即清 `realtime_active`；板心跳携带 `realtime_active`，丢失的开始/停止消息由心跳纠正。
- 固件侧：S1–S8 与旋钮改用独立 `input_events` 队列；语音任务优先处理输入；`realtime.stop` 立即发送并等待 ACK、失败每秒重试。
- 音频侧：实时音频以 `live_sink` 注册状态为唯一条件；`audio_live_start` 清除残留录音状态。
- 新增诊断字段（USB 状态 JSON）：`input_waiting / input_dropped / control_waiting / control_dropped / realtime_waiting`、`realtime_sink_calls / realtime_sink_bytes`、`audio.debug.recording / live_sink_active / live_chunk_frames`。

### 产出与验证

- 固件已烧录：MAC `14:C1:9F:39:7D:20`，启动与应用健康校验通过。
- 固件大小 `2151280` 字节，SHA-256 `6751581ffb4fe2e71884bbedfcf2efbf494e2c939cceaafdf8b11771a75d9019`。
- 网页测试 `38/38` 通过，Cloudflare 类型检查通过，`git diff --check` 通过。
- 主要代码：`firmware/easyinput-monitor/main/voice_chat.c`、`firmware/easyinput-monitor/main/audio.c`、`firmware/easyinput-monitor/main/main.c`、`cloudflare/src/device-room.ts`。

### 未解决

- 最新固件烧录后，用户再次报告“按 S1 没有停止”；最新一次串口读取被中断，尚未拿到新诊断字段的实测值。
- 尚未确认网页红点是否仍残留、实时音频是否真正开始发送。

### 接手方第一个动作

1. 重新采集串口状态（不烧录、不修改），让用户按 S7、说 2–5 秒、再按 S1。
2. 对比 `voice.debug` 中的 `last_key / mode / realtime_stops / input_waiting / input_dropped`。
3. 对比 `voice.debug.realtime_sink_calls / realtime_sink_bytes` 与 `audio.debug.live_sink_active / live_chunk_frames / recording`。
4. 按断点分支：
   - `input_dropped > 0` 或 `input_waiting > 0` 且状态不变：检查输入队列消费与语音任务。
   - `last_key == 0`、`realtime_stops == 1`，但网页仍红点：检查 Worker/网页状态同步。
   - `live_sink_active == false` 或 `realtime_sink_calls == 0`：检查 `audio_live_start` 注册与音频 worker 路径。

### 环境事实

- ESP-IDF `v5.5.5`（`/Users/jsy/esp/esp-idf-v5.5.5`）。
- 串口 `/dev/cu.usbmodem124401`；板上无 RESET/EN，开机状态短按 BOOT 进下载模式，恢复靠断电再开机。
- Wi-Fi `HUAWEI-63NAGZ_HiLink`，板地址 `192.168.3.11`。
- Cloudflare：`wss://easy.leige.online`；PWA：`https://studio.leige.online`。

### 踩坑与决策

- 实时 PCM 不能复用 BLE 网关通道；当前 BLE 保留用于监控、留言与降级，实时音频只走直连 Wi-Fi WSS。
- 实时音频帧不能与按键/控制共用一个队列，拥塞时控制事件会被静默丢弃。
- 停止消息不能只做 best-effort：需要 ACK 重试，并配合心跳状态纠正与断开清理。
- JTAG 只读检查在无符号配置下会打断目标，已用 `reset run` 恢复正常启动。

## 历史已确认功能（截至 2026-10-28）

- S1 仅未读、最早一条开始、每次短按“下一条”，无长按；S2 只播未读并回报已读。
- S3/S4 设置与旋转即报数、播完 3 秒确认；旋钮与 S3 保留长按语义。
- S5/S6 录音/发送，S6 在提示播放期间也能结束并发送；无长按定义的按键松手按短按处理。
- S8 已通过；提示音包共 150 条、语速 +35%、运行时静音裁剪。
- 历史固件包保留在 `release/firmware/`，未被清理。
