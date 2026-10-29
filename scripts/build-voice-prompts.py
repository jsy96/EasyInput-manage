#!/usr/bin/env python3
"""Build the compact board prompt pack using the approved Edge TTS voice."""

from __future__ import annotations

import argparse
import math
from pathlib import Path
import struct
import subprocess
import tempfile
import time
import wave

# IDs are permanent. Deleting a prompt must not renumber the remaining audio.
TEXTS = dict(enumerate([
    "零", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十",
    "分钟",
    "每日闹钟", "已设置好", "每日闹钟已取消",
    "倒计时", "已设置好，马上开始倒计时", "还有",
    "倒计时结束", "每日闹钟时间到了",
    "开始录音", "录音结束，短按S5发送，长按S5取消", "发送成功", "暂无语音",
]))
TEXTS.update({
    32: "百",
    33: "录音保存失败，请保持供电", 34: "录音缓存已满", 35: "没有网络连接",
    36: "手机配网模式已开启", 37: "手机配网设置失败",
})
# Keep these retired IDs reserved, and accept them only when compacting old packs.
RETIRED_PROMPT_IDS = frozenset([
    *range(24, 32), 38, 150, *range(161, 176), *range(178, 184),
    *range(186, 189), *range(190, 198),
])

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
TEXTS.update(enumerate(ALARM_TEXTS, start=39))
TEXTS.update(enumerate(COUNTDOWN_TEXTS, start=87))
TEXTS.update({
    147: "是否所有未读语音标记为已读？",
    148: "全部未读语音已标记为已读",
    149: "批量标记失败，请重试",
})
VOLUME_TEXTS = [
    "十。", "二十。", "三十。", "四十。", "五十。",
    "六十。", "七十。", "八十。", "九十。", "一百。",
]
TEXTS.update(enumerate(VOLUME_TEXTS, start=151))
PROMPT_VOICE_OVERRIDES = {
    index: ("zh-CN-XiaoxiaoNeural", "+20%")
    for index in range(151, 161)
}
TEXTS.update({
    176: "本次录音已取消", 177: "录音取消失败，请重试",
    184: "开始说话", 185: "正在转写，请稍候",
    189: "请先在小智官方平台添加设备，验证码",
})
TEXTS.update(enumerate([
    "开始与小智对话",
    "小智对话已结束",
    "小智对话连接失败，请检查网络后重试",
    "成功",
    "失败",
], start=198))

TEXTS.update(enumerate([
    "开始正计时", "本次计时共", "小时", "秒", "计时结果待播报，请稍候再开始",
    "闹钟短旋律（本地合成）",
], start=203))
ALARM_MELODY_INDEX = 208


def make_alarm_melody(output: Path) -> None:
    """An original ten-second chime, generated locally without external music."""
    notes = [523.25, 659.25, 783.99, 1046.50, 783.99, 659.25, 587.33, 0,
             523.25, 659.25, 880.00, 783.99, 659.25, 587.33, 523.25, 0,
             659.25, 783.99, 1046.50, 523.25]
    samples = bytearray()
    rate = 16000
    for frequency in notes:
        frames = rate // 2
        for i in range(frames):
            t = i / rate
            envelope = min(1.0, t / 0.015, (frames - 1 - i) / (rate * 0.04))
            value = int(3500 * envelope * math.exp(-2 * t) * math.sin(2 * math.pi * frequency * t))
            samples.extend(struct.pack("<h", value))
    with wave.open(str(output), "wb") as stream:
        stream.setnchannels(1)
        stream.setsampwidth(2)
        stream.setframerate(rate)
        stream.writeframes(samples)


def load_existing(path: Path) -> dict[int, bytes]:
    data = path.read_bytes()
    if len(data) < 8:
        raise SystemExit("Existing prompt pack header is truncated")
    magic, version, count = struct.unpack_from("<IHH", data, 0)
    if (magic, version) != (0x31504945, 1):
        raise SystemExit("Existing prompt pack has an unsupported header")
    directory_end = 8 + count * 10
    if directory_end > len(data):
        raise SystemExit("Existing prompt pack directory is truncated")
    chunks: dict[int, bytes] = {}
    spans = []
    for index in range(count):
        ident, offset, length = struct.unpack_from("<HII", data, 8 + index * 10)
        if ident in chunks or not length or offset < directory_end or offset > len(data) or length > len(data) - offset:
            raise SystemExit(f"Existing prompt pack entry {index} is invalid")
        chunks[ident] = data[offset:offset + length]
        spans.append((offset, offset + length))
    spans.sort()
    if any(current[0] < previous[1] for previous, current in zip(spans, spans[1:])):
        raise SystemExit("Existing prompt pack entries overlap")
    return chunks


def write_pack(path: Path, chunks: dict[int, bytes]) -> None:
    offset = 8 + 10 * len(chunks)
    entries = []
    payloads = []
    for ident, data in sorted(chunks.items()):
        if ident < 0 or ident > 0xffff or not data:
            raise SystemExit(f"Invalid prompt data for ID {ident}")
        entries.append(struct.pack("<HII", ident, offset, len(data)))
        payloads.append(data)
        offset += len(data)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(struct.pack("<IHH", 0x31504945, 1, len(chunks)) + b"".join(entries) + b"".join(payloads))


def synthesize(
    tts_script: Path, text: str, output: Path, voice: str, rate: str
) -> None:
    command = [
        "python3", str(tts_script), "--text", text, "--output", str(output),
        "--voice", voice, f"--rate={rate}", "--overwrite", "--timeout", "180",
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
    parser.add_argument("--reuse-existing", action="store_true", help="Keep active prompt IDs, drop retired IDs and generate missing prompts")
    parser.add_argument("--refresh-first", type=int, default=0, metavar="N", help="With --reuse-existing, regenerate the first N existing active prompts in ID order")
    parser.add_argument("--refresh-from", type=int, default=0, metavar="ID", help="With --reuse-existing, regenerate active prompts from this existing ID through the end")
    parser.add_argument("--refresh-index", type=int, action="append", default=[], metavar="ID", help="With --reuse-existing, replace only these existing active IDs and generate missing prompts")
    parser.add_argument("--work-dir", type=Path, help="Reuse a directory for generated prompts instead of discarding partial work")
    args = parser.parse_args()
    chunks = load_existing(args.output) if args.reuse_existing and args.output.is_file() else {}
    unknown = chunks.keys() - TEXTS.keys() - RETIRED_PROMPT_IDS
    if unknown:
        raise SystemExit(f"Existing prompt pack contains unknown IDs: {sorted(unknown)}")
    chunks = {ident: data for ident, data in chunks.items() if ident in TEXTS}
    if sum(bool(value) for value in (args.refresh_first, args.refresh_from, args.refresh_index)) > 1:
        raise SystemExit("Prompt refresh options are mutually exclusive")
    if args.refresh_index and (not args.reuse_existing or any(index not in chunks for index in args.refresh_index)):
        raise SystemExit("--refresh-index requires --reuse-existing and existing active prompt IDs")
    requested = set(args.refresh_index)
    if args.refresh_first:
        if not args.reuse_existing:
            raise SystemExit("--refresh-first requires --reuse-existing")
        if args.refresh_first < 1 or args.refresh_first > len(chunks):
            raise SystemExit("--refresh-first must be within the existing prompt count")
        requested.update(sorted(chunks)[:args.refresh_first])
    elif args.refresh_from:
        if not args.reuse_existing:
            raise SystemExit("--refresh-from requires --reuse-existing")
        if args.refresh_from not in chunks:
            raise SystemExit("--refresh-from must reference an existing active prompt ID")
        requested.update(index for index in TEXTS if index >= args.refresh_from)
    indices = sorted((TEXTS.keys() - chunks.keys()) | requested)
    if any(index != ALARM_MELODY_INDEX for index in indices) and not args.tts_script.is_file():
        raise SystemExit(f"TTS script not found: {args.tts_script}")
    temporary_directory = None
    if indices and args.work_dir is not None:
        root = args.work_dir.expanduser()
        root.mkdir(parents=True, exist_ok=True)
    elif indices:
        temporary_directory = tempfile.TemporaryDirectory(prefix="easyinput-prompts-")
        root = Path(temporary_directory.name)
    try:
        for index in indices:
            text = TEXTS[index]
            mp3 = root / f"{index:02d}.mp3"
            ulaw = root / f"{index:02d}.ulaw"
            text_file = root / f"{index:02d}.txt"
            if ulaw.is_file() and ulaw.stat().st_size and text_file.is_file() and text_file.read_text() == text:
                continue
            if index == ALARM_MELODY_INDEX:
                melody = root / "alarm-melody.wav"
                make_alarm_melody(melody)
                to_ulaw(melody, ulaw)
            else:
                voice, rate = PROMPT_VOICE_OVERRIDES.get(index, ("yunjian", "+35%"))
                synthesize(args.tts_script, text, mp3, voice, rate)
                to_ulaw(mp3, ulaw)
            data = ulaw.read_bytes()
            if not data:
                raise SystemExit(f"Empty prompt: {text}")
            text_file.write_text(text)
            if index != ALARM_MELODY_INDEX:
                time.sleep(15)
        for index in indices:
            data = (root / f"{index:02d}.ulaw").read_bytes()
            if not data:
                raise SystemExit(f"Empty prompt: {TEXTS[index]}")
            chunks[index] = data
    finally:
        if temporary_directory is not None:
            temporary_directory.cleanup()
    write_pack(args.output, chunks)
    print(f"{len(chunks)} prompts -> {args.output} ({args.output.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
