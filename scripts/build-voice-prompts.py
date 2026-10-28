#!/usr/bin/env python3
"""Build the compact board prompt pack using the approved Edge TTS voice."""

from __future__ import annotations

import argparse
from pathlib import Path
import struct
import subprocess
import tempfile
import time

TEXTS = [
    "零", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十",
    "分钟",
    "每日闹钟", "已设置好", "每日闹钟已取消",
    "倒计时", "已设置好，马上开始倒计时", "还有",
    "倒计时结束", "每日闹钟时间到了",
    "开始录音", "录音结束，短按S6发送", "发送成功", "暂无语音",
    "实时监听未开启", "开始实时监听", "实时监听已结束",
    "开发板在线", "开发板未联网", "电脑端", "人在线", "未知", "百",
    "录音保存失败，请保持供电", "录音缓存已满", "没有网络连接",
    "手机配网模式已开启", "手机配网设置失败",
    "下一条",
]

CN_DIGITS = "零一二三四五六七八九"


def chinese_number(value: int) -> str:
    if value < 10:
        return CN_DIGITS[value]
    if value < 20:
        return "十" + (CN_DIGITS[value % 10] if value % 10 else "")
    return CN_DIGITS[value // 10] + "十" + (CN_DIGITS[value % 10] if value % 10 else "")


ALARM_TEXTS = [f"{chinese_number(hour)}点{chinese_number(minute)}分"
               for hour in range(24) for minute in (0, 30)]
COUNTDOWN_TEXTS = [f"{chinese_number(minute)}分钟" for minute in range(1, 61)]
TEXTS.extend(ALARM_TEXTS)
TEXTS.extend(COUNTDOWN_TEXTS)
TEXTS.append("是否所有未读语音标记为已读？")


def load_existing(path: Path) -> list[bytes]:
    data = path.read_bytes()
    magic, version, count = struct.unpack_from("<IHH", data, 0)
    if (magic, version) != (0x31504945, 1):
        raise SystemExit("Existing prompt pack has an unsupported header")
    chunks: list[bytes] = []
    for index in range(count):
        ident, offset, length = struct.unpack_from("<HII", data, 8 + index * 10)
        if ident != index or not length or offset > len(data) or length > len(data) - offset:
            raise SystemExit(f"Existing prompt pack entry {index} is invalid")
        chunks.append(data[offset:offset + length])
    return chunks


def synthesize(tts_script: Path, text: str, output: Path) -> None:
    command = [
        "python3", str(tts_script), "--text", text, "--output", str(output),
        "--voice", "yunjian", "--rate=+35%", "--overwrite", "--timeout", "90",
    ]
    for attempt in range(2):
        try:
            subprocess.run(command, check=True, stdout=subprocess.DEVNULL)
            return
        except subprocess.CalledProcessError:
            if attempt == 1:
                raise
            time.sleep(2)


def to_ulaw(mp3: Path, output: Path) -> None:
    subprocess.run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(mp3),
        "-af",
        "silenceremove=start_periods=1:start_duration=0.02:start_threshold=-45dB,"
        "areverse,"
        "silenceremove=start_periods=1:start_duration=0.02:start_threshold=-45dB,"
        "areverse",
        "-ac", "1", "-ar", "8000", "-c:a", "pcm_mulaw", "-f", "mulaw", str(output),
    ], check=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--tts-script", type=Path, default=Path.home() / ".codex/skills/edge-tts-chinese/scripts/tts.py")
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parents[1] / "firmware/easyinput-monitor/main/assets/prompts.bin")
    parser.add_argument("--reuse-existing", action="store_true", help="Keep entries already present and append missing prompts")
    parser.add_argument("--refresh-first", type=int, default=0, metavar="N", help="With --reuse-existing, regenerate the first N entries")
    args = parser.parse_args()
    if not args.tts_script.is_file():
        raise SystemExit(f"TTS script not found: {args.tts_script}")
    chunks = load_existing(args.output) if args.reuse_existing and args.output.is_file() else []
    if len(chunks) > len(TEXTS):
        raise SystemExit("Existing prompt pack contains more entries than this script defines")
    if args.refresh_first:
        if not args.reuse_existing:
            raise SystemExit("--refresh-first requires --reuse-existing")
        if args.refresh_first < 1 or args.refresh_first > len(chunks):
            raise SystemExit("--refresh-first must be within the existing prompt count")
        start_index, end_index = 0, args.refresh_first
    else:
        start_index, end_index = len(chunks), len(TEXTS)
    with tempfile.TemporaryDirectory(prefix="easyinput-prompts-") as temp:
        root = Path(temp)
        for index in range(start_index, end_index):
            text = TEXTS[index]
            mp3 = root / f"{index:02d}.mp3"
            ulaw = root / f"{index:02d}.ulaw"
            synthesize(args.tts_script, text, mp3)
            to_ulaw(mp3, ulaw)
            data = ulaw.read_bytes()
            if not data:
                raise SystemExit(f"Empty prompt: {text}")
            if index < len(chunks):
                chunks[index] = data
            else:
                chunks.append(data)
    header_size = struct.calcsize("<IHH")
    entry_size = struct.calcsize("<HII")
    offset = header_size + entry_size * len(chunks)
    entries = []
    for index, data in enumerate(chunks):
        entries.append(struct.pack("<HII", index, offset, len(data)))
        offset += len(data)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes(struct.pack("<IHH", 0x31504945, 1, len(chunks)) + b"".join(entries) + b"".join(chunks))
    print(f"{len(chunks)} prompts -> {args.output} ({args.output.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
