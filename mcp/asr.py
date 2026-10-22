#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""asr.py — 本地 Whisper 轉寫（faster-whisper / CTranslate2，CPU int8）。

為什麼有這支：YouTube 有一批影片沒有字幕軌（純音樂、直播回放、關閉字幕），
`yt_transcript` 只能回 `no_captions`。這支腳本讓那一輪能在本機把音檔轉成文字，
補上最後一手，不必送雲端。

用法（venv 的 python 才裝了 faster-whisper）：

    ~/.dsh/yt-duty/asr-venv/bin/python <mcp>/asr.py <audio-file> \
        --model base --lang zh --out <json-path>

輸出（--out 檔與 stdout 同一份）：
    成功 {"ok":true,"text":...,"lang":...,"segments":[{"start","end","text"}],
          "model":"base","seconds":12.3, ...}
    失敗 {"ok":false,"error":"..."}   且 exit code 1

約定：
  * 只依賴 faster-whisper（它自帶 ctranslate2 / av，不碰系統 ffmpeg / ffprobe）。
  * 模型快取到 $YT_DUTY_HOME/models（預設 ~/.dsh/yt-duty/models），不寫使用者家目錄其他角落。
  * stdout 只有那一份 JSON；進度、警告一律走 stderr；兩者都鎖 UTF-8。
  * `--check` 只體檢環境（venv / 套件版本 / 模型快取），不轉寫。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import traceback

SCRIPT_VERSION = "1.0"
DEFAULT_MODEL = "base"
HF_MIRROR = "https://hf-mirror.com"


# ---------------------------------------------------------------- 環境 / 路徑

def yt_home() -> str:
    """狀態目錄：YT_DUTY_HOME > $DSH_HOME/yt-duty > ~/.dsh/yt-duty（與 server.mjs 同口徑）。"""
    env = os.environ.get("YT_DUTY_HOME")
    if env and env.strip():
        return os.path.abspath(os.path.expanduser(env.strip()))
    dsh = os.environ.get("DSH_HOME")
    if dsh and dsh.strip():
        return os.path.join(os.path.abspath(os.path.expanduser(dsh.strip())), "yt-duty")
    return os.path.expanduser("~/.dsh/yt-duty")


def models_dir() -> str:
    env = os.environ.get("YT_ASR_MODELS")
    path = os.path.abspath(os.path.expanduser(env.strip())) if env and env.strip() else os.path.join(yt_home(), "models")
    os.makedirs(path, exist_ok=True)
    return path


def pin_utf8() -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def emit(payload: dict, out_path: str | None, code: int) -> int:
    """把 JSON 同時寫檔（原子替換）與 stdout，然後回傳 exit code。"""
    text = json.dumps(payload, ensure_ascii=False, indent=1)
    if out_path:
        try:
            parent = os.path.dirname(os.path.abspath(out_path))
            if parent:
                os.makedirs(parent, exist_ok=True)
            tmp = out_path + ".part"
            with open(tmp, "w", encoding="utf-8") as fh:
                fh.write(text + "\n")
            os.replace(tmp, out_path)
        except Exception as exc:  # 寫不了 out 不該吞掉結果：還是印到 stdout
            log(f"[asr] 警告：寫不了 --out（{exc}），只輸出到 stdout")
    print(text, flush=True)
    return code


def fail(error: str, out_path: str | None, extra: dict | None = None) -> int:
    payload = {"ok": False, "error": error}
    if extra:
        payload.update(extra)
    log(f"[asr] 失敗：{error}")
    return emit(payload, out_path, 1)


# ---------------------------------------------------------------- 引數

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="asr.py",
        description="本地 Whisper 轉寫（faster-whisper，CPU int8）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("audio", nargs="?", help="音檔路徑（m4a/webm/mp3/wav/flac 皆可）")
    p.add_argument("--model", default=DEFAULT_MODEL, help="模型名或本地目錄（預設 base；小=快，medium=準但慢）")
    p.add_argument("--out", default=None, help="輸出 JSON 路徑；省略就只印到 stdout")
    p.add_argument("--lang", default=None, help="強制語言（zh / zh-Hant / en / ja…）；省略則自動偵測")
    p.add_argument("--compute-type", default="int8", help="CTranslate2 精度：int8（預設，CPU 最省）/ float32 / int16")
    p.add_argument("--beam-size", type=int, default=5, help="beam search 寬度（預設 5；1=貪心，快但差）")
    p.add_argument("--threads", type=int, default=0, help="CPU 執行緒數（0=自動）")
    p.add_argument("--vad", action="store_true", help="先做 VAD 切掉靜音（長片可少幻覺；需 onnxruntime）")
    p.add_argument("--max-seconds", type=float, default=0.0, help="只轉前 N 秒（0=全部；長片保命用）")
    p.add_argument("--check", action="store_true", help="只體檢環境：venv / 套件 / 模型快取，不轉寫")
    p.add_argument("--version", action="version", version=f"asr.py {SCRIPT_VERSION}")
    return p


# ---------------------------------------------------------------- 體檢

def run_check(out_path: str | None) -> int:
    info: dict = {
        "ok": True,
        "script": f"asr.py {SCRIPT_VERSION}",
        "python": sys.executable,
        "python_version": sys.version.split()[0],
        "in_venv": sys.prefix != sys.base_prefix,
        "yt_home": yt_home(),
        "models_dir": models_dir(),
        "hf_endpoint": os.environ.get("HF_ENDPOINT", ""),
    }
    try:
        import faster_whisper  # noqa: WPS433

        info["faster_whisper"] = getattr(faster_whisper, "__version__", "?")
    except Exception as exc:
        info["ok"] = False
        info["error"] = f"import faster_whisper 失敗（{type(exc).__name__}: {exc}）"
        info["hint"] = "要用 ~/.dsh/yt-duty/asr-venv/bin/python 執行本腳本，不是系統 python3"
        return emit(info, out_path, 1)
    for mod in ("ctranslate2", "av", "huggingface_hub"):
        try:
            m = __import__(mod)
            info[mod] = getattr(m, "__version__", "?")
        except Exception:
            info[mod] = None
    cached = []
    for name in sorted(os.listdir(info["models_dir"])):
        full = os.path.join(info["models_dir"], name)
        if os.path.isdir(full):
            cached.append({"name": name, "bytes": dir_bytes(full)})
    info["models_cached"] = cached
    return emit(info, out_path, 0)


def dir_bytes(path: str) -> int:
    total = 0
    for root, _dirs, files in os.walk(path):
        for fn in files:
            try:
                total += os.path.getsize(os.path.join(root, fn))
            except OSError:
                pass
    return total


# ---------------------------------------------------------------- 主流程

def load_model(model: str, compute_type: str, threads: int):
    from faster_whisper import WhisperModel  # 延後匯入：--check 也要能給好訊息

    root = models_dir()
    kwargs: dict = {"device": "cpu", "compute_type": compute_type, "download_root": root}
    if threads and threads > 0:
        kwargs["cpu_threads"] = int(threads)
    try:
        return WhisperModel(model, **kwargs)
    except Exception as exc:
        # Apple Silicon 上少數 ctranslate2 版本不吃 int8；退一個檔次再試，不要直接死。
        if compute_type != "float32":
            log(f"[asr] compute_type={compute_type} 不支援（{type(exc).__name__}: {exc}），改試 float32")
            kwargs["compute_type"] = "float32"
            try:
                return WhisperModel(model, **kwargs)
            except Exception as exc2:
                raise RuntimeError(
                    f"模型載入失敗（{model}）：{type(exc2).__name__}: {exc2}。"
                    f"若為下載失敗，設 HF_ENDPOINT={HF_MIRROR} 後重試；模型快取在 {root}"
                ) from exc2
        raise


def main(argv: list[str]) -> int:
    pin_utf8()
    args = build_parser().parse_args(argv)

    if not os.environ.get("HF_ENDPOINT"):
        # 這台機器在 CN 網路；官方 HF 常常連不上。只在沒設時給預設，設了就以你的為準。
        os.environ["HF_ENDPOINT"] = HF_MIRROR
    os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")

    if args.check:
        return run_check(args.out)

    if not args.audio:
        return fail("缺少音檔路徑", args.out)

    audio = os.path.abspath(os.path.expanduser(args.audio))
    if not os.path.exists(audio):
        return fail(f"音檔不存在：{audio}", args.out)
    if not os.path.isfile(audio):
        return fail(f"不是檔案：{audio}", args.out)
    size = os.path.getsize(audio)
    if size < 1024:
        return fail(f"音檔太小（{size} bytes），大概是抓到空檔或錯誤頁：{audio}", args.out)

    t0 = time.time()
    log(f"[asr] 音檔 {audio}（{size / 1024 / 1024:.1f} MB）model={args.model} compute={args.compute_type}")
    log(f"[asr] 模型快取 {models_dir()}（首次執行會下載 {args.model}，base≈145MB）")

    try:
        model = load_model(args.model, args.compute_type, args.threads)
    except Exception as exc:
        msg = str(exc) if isinstance(exc, RuntimeError) else f"{type(exc).__name__}: {exc}"
        return fail(msg if msg.startswith("模型") else f"模型載入失敗：{msg}", args.out)

    kwargs: dict = {
        "language": args.lang,
        "beam_size": args.beam_size,
        "vad_filter": bool(args.vad),
        "condition_on_previous_text": False,  # 關掉才能壓住長音檔的無限重複幻覺
        "word_timestamps": False,
    }
    if args.vad:
        kwargs["vad_parameters"] = {"min_silence_duration_ms": 500}
    if args.max_seconds and args.max_seconds > 0:
        kwargs["clip_timestamps"] = [0.0, float(args.max_seconds)]

    try:
        try:
            segments_iter, info = model.transcribe(audio, **kwargs)
        except TypeError:
            # 舊版 faster-whisper 沒有 clip_timestamps；把這個保命參數拿掉再試。
            kwargs.pop("clip_timestamps", None)
            segments_iter, info = model.transcribe(audio, **kwargs)

        log(f"[asr] 偵測語言={info.language} (p={getattr(info, 'language_probability', 0):.2f})，開始轉寫…")
        segments: list[dict] = []
        pieces: list[str] = []
        for seg in segments_iter:  # 產生器：這圈才是真正在算
            text = (seg.text or "").strip()
            if not text:
                continue
            segments.append({
                "start": round(float(seg.start), 2),
                "end": round(float(seg.end), 2),
                "text": text,
            })
            pieces.append(seg.text or "")
            if len(segments) % 50 == 0:
                log(f"[asr] …已轉 {len(segments)} 段（{seg.end:.1f}s）")
    except Exception as exc:
        detail = f"{type(exc).__name__}: {exc}"
        if os.environ.get("YT_ASR_DEBUG"):
            detail += "\n" + traceback.format_exc(limit=3)
        return fail(f"轉寫失敗：{detail}", args.out)

    seconds = round(time.time() - t0, 2)
    audio_seconds = round(float(getattr(info, "duration", 0.0) or 0.0), 2)
    # --max-seconds 時 info.duration 仍是整條音檔；速度倍率要按「實際處理的秒數」算才誠實。
    processed = audio_seconds
    if args.max_seconds and args.max_seconds > 0:
        processed = round(min(audio_seconds, float(args.max_seconds)), 2) if audio_seconds else round(float(args.max_seconds), 2)
    payload = {
        "ok": True,
        "text": "".join(pieces).strip(),
        "lang": info.language,
        "lang_probability": round(float(getattr(info, "language_probability", 0.0)), 3),
        "segments": segments,
        "model": args.model,
        "seconds": seconds,
        "audio_seconds": audio_seconds,
        "processed_seconds": processed,
        "compute_type": args.compute_type,
        "script": f"asr.py {SCRIPT_VERSION}",
    }
    if not segments:
        payload["silent"] = True  # 純音樂／全靜音：text 是空的，呼叫方該跳過這條
    if processed and seconds:
        payload["realtime_factor"] = round(processed / seconds, 2)
    log(f"[asr] 完成：{len(segments)} 段 / {seconds}s（處理 {processed}s，×{payload.get('realtime_factor', '?')} 實時）")
    return emit(payload, args.out, 0)


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except KeyboardInterrupt:
        sys.exit(fail("被中斷（Ctrl-C）", None))
