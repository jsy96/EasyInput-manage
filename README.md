# EasyInput Studio

EasyInput Studio 是 EasyInput V2.0 开发板的浏览器 PWA。网页和开发板共用一条语音时间线，不区分电脑数量，也不提供文字消息或文字转语音消息。

- 线上网页：https://studio.leige.online
- 语音服务：`wss://easy.leige.online`
- 目录约定：[AGENTS.md](AGENTS.md)
- 使用说明：[docs/VOICE_CHAT.md](docs/VOICE_CHAT.md)
- 协议：[docs/PROTOCOL.md](docs/PROTOCOL.md)

## 当前功能

- 网页与开发板录音统一按时间排序，最新一条显示在最上方。
- 网页只发送语音；每条录音最长 20 秒。
- S1 直接播放前一条历史语音，连续短按继续回听更早的信息，包括已读语音；到最早一条后不循环。长按 3 秒进入批量已读确认。
- S2 播放第一条未读语音，并重设 S1 回听起点；播放中按 S1 直接切到前一条，按 S2 从第一条未读开头播放，其他键停止。
- S3 设置每日闹钟，长按 S3 取消。
- S4 设置倒计时，运行中每秒短滴答、每分钟长滴答并播报剩余分钟。
- S5 开始录音，S6 发送；发送失败自动重试，成功后语音提示。
- S7 通过 20 ms PCM16 二进制流发送开发板麦克风声音到网页，实时内容不写入历史；实时中短按 S8 结束监听并语音提示。
- S8 语音播报开发板是否联网，以及当前唯一在线的网页电脑数。
- 网页只保留“语音”和“设备”两页。设备页负责在线状态、Wi-Fi/语音服务配置和固件升级。

完整按键和灯效约定见 [VOICE_CHAT.md](docs/VOICE_CHAT.md)。

## 本地运行

```sh
npm install
npm run dev
```

打开 `http://127.0.0.1:5173`。生产构建：

```sh
npm run build
```

网页构建产物写入 `dist/`。USB Serial、Web Bluetooth 和 PWA 安装需要 HTTPS 或 localhost，并使用当前版本的桌面 Chrome / Edge。

## 网页与云端检查

```sh
npm run typecheck
npm test
cd cloudflare
npm run typecheck
```

## 固件构建

开发板目标为 ESP32-S3，当前工程使用 ESP-IDF 5.5.5：

```sh
cd firmware/easyinput-monitor
idf.py build
python3 ../../scripts/export-firmware.py --version 0.4.1
```

固件包写入 `release/firmware/0.4.1-v2-monitor/`。`build/`、`release/`、`node_modules/`、生成的 `sdkconfig` 和 `managed_components/` 不提交 Git。

中文提示音由 [scripts/build-voice-prompts.py](scripts/build-voice-prompts.py) 使用 `edge-tts-chinese` 的云健男声生成，再转换为 8 kHz 单声道 μ-law 并打包为 `firmware/easyinput-monitor/main/assets/prompts.bin`。

## 烧录

在“设备 → 固件升级”中选择包含 `firmware.json`、bootloader、分区表和应用镜像的完整目录。网页会校验清单、文件大小和 SHA-256，识别到 ESP32-S3 后要求再次确认才写入。

自动进入下载模式失败时，保持开发板开机，短按并松开一次 BOOT，再重试并选择 ESP32 下载端口。板上没有独立 RESET/EN 键；更新完成后关机再开机恢复正常运行。

## 尚未完成或需要真机验收

- 所有红色慢闪状态统一为亮 0.5 秒、熄灭 2 秒；五颗 WS2812 点亮亮度为 1%。
- 固件编译和自动化测试不能替代板载麦克风、扬声器、GPIO8 共享电源、灯序、按键方向和声音水平/音质的实板验证。
- 实时聆听依赖 Wi-Fi 直连或保持运行的蓝牙网关网页；网络中断时会停止并语音提示离线。
