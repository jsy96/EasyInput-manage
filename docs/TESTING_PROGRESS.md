# 测试进度

> 最近更新：2026-10-28（Asia/Shanghai）
> 保存说明：项目目录约定未建立 `flow/`，专题进展按 `AGENTS.md` 规则放入 `docs/`。本文件顶部一条为当前交接棒，向下为历史。

## 当前状态：S7 实时音频主链路已通，0.4.6 验收通过（2026-10-28）

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
