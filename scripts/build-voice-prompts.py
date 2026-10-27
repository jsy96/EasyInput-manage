#!/usr/bin/env python3
"""Build the compact board prompt pack using the approved Edge TTS voice."""

from __future__ import annotations

import argparse
from pathlib import Path
import struct
import subprocess
import tempfile

TEXTS = [
    "零", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十",
    "点", "分", "分钟", "整",
    "每日闹钟", "已设置好", "每日闹钟已取消",
    "倒计时", "已设置好，马上开始倒计时", "还有",
    "倒计时结束", "每日闹钟时间到了",
    "开始录音", "录音结束，短按S6发送", "发送成功", "暂无语音",
    "实时监听未开启", "开始实时监听", "实时监听已结束",
    "开发板在线", "开发板未联网", "电脑端", "人在线", "未知", "百",
    "录音保存失败，请保持供电", "录音缓存已满", "没有网络连接",
    "手机配网模式已开启", "手机配网设置失败",
]


def synthesize(tts_script: Path, text: str, output: Path) -> None:
    subprocess.run([
        "python3", str(tts_script), "--text", text, "--output", str(output),
        "--voice", "yunjian", "--rate=-10%", "--overwrite", "--timeout", "90",
    ], check=True, stdout=subprocess.DEVNULL)


def to_ulaw(mp3: Path, output: Path) -> None:
    subprocess.run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(mp3),
        "-ac", "1", "-ar", "8000", "-c:a", "pcm_mulaw", "-f", "mulaw", str(output),
    ], check=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--tts-script", type=Path, default=Path.home() / ".codex/skills/edge-tts-chinese/scripts/tts.py")
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parents[1] / "firmware/easyinput-monitor/main/assets/prompts.bin")
    args = parser.parse_args()
    if not args.tts_script.is_file():
        raise SystemExit(f"TTS script not found: {args.tts_script}")
    chunks: list[bytes] = []
    with tempfile.TemporaryDirectory(prefix="easyinput-prompts-") as temp:
        root = Path(temp)
        for index, text in enumerate(TEXTS):
            mp3 = root / f"{index:02d}.mp3"
            ulaw = root / f"{index:02d}.ulaw"
            synthesize(args.tts_script, text, mp3)
            to_ulaw(mp3, ulaw)
            data = ulaw.read_bytes()
            if not data:
                raise SystemExit(f"Empty prompt: {text}")
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
