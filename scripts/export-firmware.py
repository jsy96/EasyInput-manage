#!/usr/bin/env python3
"""Package the non-erasing ESP-IDF images listed in build/flash_args."""

import argparse
import hashlib
import json
import re
import shlex
import shutil
from pathlib import Path


PROJECT = Path(__file__).resolve().parents[1] / "firmware" / "easyinput-monitor"


def collect_images(build_dir: Path):
    args_file = build_dir / "flash_args"
    if not args_file.is_file():
        raise SystemExit(f"Missing {args_file}; build the firmware first.")
    tokens = shlex.split(args_file.read_text(encoding="utf-8"))
    images = []
    for index, token in enumerate(tokens[:-1]):
        if re.fullmatch(r"0x[0-9a-fA-F]+", token):
            candidate = Path(tokens[index + 1])
            if candidate.suffix.lower() == ".bin":
                address = int(token, 16)
                if address not in {0x0, 0x8000, 0x10000}:
                    raise SystemExit(f"Unexpected firmware image offset: {address:#x}")
                path = candidate if candidate.is_absolute() else build_dir / candidate
                if not path.is_file():
                    raise SystemExit(f"Image from flash_args is missing: {path}")
                images.append((address, path))
    addresses = [address for address, _ in images]
    required = {0x0, 0x8000, 0x10000}
    if len(addresses) != len(required) or set(addresses) != required:
        missing = ", ".join(f"0x{address:X}" for address in sorted(required - set(addresses)))
        raise SystemExit(f"Expected bootloader, partition table and app images; missing offsets: {missing}")
    return sorted(images)


def collect_flash_settings(build_dir: Path):
    tokens = shlex.split((build_dir / "flash_args").read_text(encoding="utf-8"))
    settings = {}
    for key in ("--flash_mode", "--flash_freq", "--flash_size"):
        if key in tokens:
            settings[key] = tokens[tokens.index(key) + 1]
    return {
        "mode": settings.get("--flash_mode", "dio"),
        "frequency": settings.get("--flash_freq", "40m"),
        "size": settings.get("--flash_size", "16MB"),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--version", required=True, help="Firmware version stored in the local bundle")
    parser.add_argument("--output", help="Package output folder; defaults to release/firmware/<version>-v2-monitor")
    args = parser.parse_args()

    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._+-]{0,63}", args.version):
        raise SystemExit("Version must use letters, digits, dot, underscore, plus, or hyphen.")

    build_dir = PROJECT / "build"
    build_info_path = build_dir / "project_description.json"
    if not build_info_path.is_file():
        raise SystemExit(f"Missing {build_info_path}; build the firmware first.")
    build_info = json.loads(build_info_path.read_text(encoding="utf-8"))
    embedded_version = str(build_info.get("project_version", ""))
    if embedded_version != args.version:
        actual_version = embedded_version or "(missing)"
        raise SystemExit(f"Requested package version {args.version} does not match built firmware {actual_version}.")

    images = collect_images(build_dir)
    flash_settings = collect_flash_settings(build_dir)
    output_dir = Path(args.output).resolve() if args.output else PROJECT.parents[1] / "release" / "firmware" / f"{args.version}-v2-monitor"
    output_dir.mkdir(parents=True, exist_ok=True)
    manifest_images = []

    for address, source in images:
        target = output_dir / source.name
        shutil.copy2(source, target)
        data = target.read_bytes()
        manifest_images.append({
            "file": target.name,
            "address": address,
            "bytes": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
        })

    manifest = {
        "format": "easyinput-firmware",
        "formatVersion": 1,
        "board": "easyinput-v2",
        "chip": "esp32s3",
        "version": args.version,
        "flash": {**flash_settings, "eraseAll": False},
        "images": manifest_images,
    }
    (output_dir / "firmware.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"Firmware bundle: {output_dir}")
    for image in manifest_images:
        print(f"  {image['address']:#08x}  {image['file']}  {image['bytes']} bytes")


if __name__ == "__main__":
    main()
