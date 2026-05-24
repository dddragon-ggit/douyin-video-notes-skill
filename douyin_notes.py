#!/usr/bin/env python3
"""视频笔记生成器 - 下载视频并转录为文字（支持抖音、B站等平台）"""

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse

import requests

MOBILE_UA = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 "
    "Mobile/15E148 Safari/604.1"
)


# ───────────────────────── 平台检测 ─────────────────────────

def detect_platform(url: str) -> str:
    """检测视频平台，返回 'douyin' / 'bilibili' / 'generic'"""
    if any(h in url for h in ("douyin.com", "iesdouyin.com", "v.douyin.com", "vm.tiktok.com")):
        return "douyin"
    if any(h in url for h in ("bilibili.com", "b23.tv")):
        return "bilibili"
    return "generic"


# ───────────────────────── 通用工具 ─────────────────────────

def resolve_short_url(url: str) -> str:
    """解析短链接，获取真实URL"""
    resp = requests.head(url, headers={"User-Agent": MOBILE_UA},
                         allow_redirects=True, timeout=15)
    return resp.url


def extract_audio(video_path: str, output_dir: str) -> str:
    """使用 ffmpeg 从视频中提取音频"""
    audio_path = os.path.join(output_dir, "audio.mp3")
    cmd = [
        "ffmpeg", "-y",
        "-i", video_path,
        "-vn",
        "-acodec", "libmp3lame",
        "-ar", "16000",
        "-ac", "1",
        "-q:a", "2",
        audio_path,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg 提取音频失败: {result.stderr}")
    return audio_path


# ───────────────────── yt-dlp 通用接口 ─────────────────────

def _ytdlp_info(url: str) -> dict:
    """用 yt-dlp 获取视频元信息"""
    cmd = [sys.executable, "-m", "yt_dlp",
           "--dump-json", "--no-download", "--no-warnings", url]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    if result.returncode != 0:
        raise RuntimeError(f"yt-dlp 获取信息失败: {result.stderr}")
    return json.loads(result.stdout)


def _ytdlp_download(url: str, output_dir: str) -> str:
    """用 yt-dlp 下载视频，返回文件路径"""
    output_template = os.path.join(output_dir, "%(id)s.%(ext)s")
    cmd = [sys.executable, "-m", "yt_dlp",
           "-f", "bestvideo+bestaudio/best",
           "--merge-output-format", "mp4",
           "-o", output_template,
           "--no-warnings", "--no-playlist", url]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    if result.returncode != 0:
        raise RuntimeError(f"yt-dlp 下载失败: {result.stderr}")
    files = list(Path(output_dir).glob("*"))
    video_files = [f for f in files if f.suffix in (".mp4", ".webm", ".mkv", ".flv")]
    if not video_files:
        raise RuntimeError("未找到下载的视频文件")
    return str(video_files[0])


# ───────────────────────── 抖音专用 ─────────────────────────

def extract_douyin_id(url: str) -> str:
    """从抖音URL中提取视频ID"""
    for pattern in [r'/video/(\d+)', r'modal_id=(\d+)', r'/note/(\d+)']:
        match = re.search(pattern, url)
        if match:
            return match.group(1)
    return ""


def fetch_douyin_page_data(video_id: str) -> dict:
    """从抖音分享页面解析视频数据"""
    share_url = f"https://www.iesdouyin.com/share/video/{video_id}/"
    resp = requests.get(share_url, headers={"User-Agent": MOBILE_UA},
                        timeout=15, allow_redirects=True)
    resp.raise_for_status()
    m = re.search(
        r'window\._ROUTER_DATA\s*=\s*({.*?})\s*</script>',
        resp.text, re.DOTALL,
    )
    if not m:
        raise RuntimeError("无法从页面中提取视频数据")
    raw = m.group(1).replace('\\u002F', '/')
    return json.loads(raw)


def find_aweme_detail(data: dict, depth: int = 0):
    """递归查找 aweme 详情对象"""
    if depth > 15:
        return None
    if isinstance(data, dict):
        if 'aweme_id' in data or 'awemeId' in data:
            return data
        for v in data.values():
            r = find_aweme_detail(v, depth + 1)
            if r:
                return r
    elif isinstance(data, list):
        for item in data:
            r = find_aweme_detail(item, depth + 1)
            if r:
                return r
    return None


def douyin_get_info(url: str, detail: dict = None) -> dict:
    """获取抖音视频元信息"""
    video_id = extract_douyin_id(url)
    if not video_id:
        raise RuntimeError(f"无法从 URL 中提取视频 ID: {url}")
    if detail is None:
        data = fetch_douyin_page_data(video_id)
        detail = find_aweme_detail(data)
        if not detail:
            raise RuntimeError("无法从页面数据中找到视频详情")
    desc = detail.get("desc", "")
    author = detail.get("author", {}).get("nickname", "未知作者")
    duration = detail.get("duration", 0)
    if duration > 1000:
        duration = duration // 1000
    return {
        "title": desc[:80] if desc else "未知标题",
        "author": author,
        "description": desc,
        "duration": duration,
        "video_id": video_id,
        "url": url,
        "platform": "douyin",
    }


def douyin_download(url: str, output_dir: str, detail: dict = None) -> str:
    """下载抖音视频"""
    video_id = extract_douyin_id(url)
    if not video_id:
        raise RuntimeError(f"无法从 URL 中提取视频 ID: {url}")
    if detail is None:
        data = fetch_douyin_page_data(video_id)
        detail = find_aweme_detail(data)
        if not detail:
            raise RuntimeError("无法从页面数据中找到视频详情")
    video_info = detail.get("video", {})
    play_addr = video_info.get("play_addr", {})
    url_list = play_addr.get("url_list", [])
    video_url = None
    for u in url_list:
        if "playwm" in u:
            video_url = u.replace("playwm", "play")
            break
    if not video_url and url_list:
        video_url = url_list[0]
    if not video_url:
        raise RuntimeError("未找到视频下载链接")
    headers = {"User-Agent": MOBILE_UA, "Referer": "https://www.douyin.com/"}
    resp = requests.get(video_url, headers=headers, timeout=120, stream=True)
    resp.raise_for_status()
    video_path = os.path.join(output_dir, f"{video_id}.mp4")
    with open(video_path, "wb") as f:
        for chunk in resp.iter_content(chunk_size=8192):
            f.write(chunk)
    return video_path


def douyin_parse(url: str):
    """解析抖音页面，返回 (info, detail) 供复用"""
    video_id = extract_douyin_id(url)
    if not video_id:
        raise RuntimeError(f"无法从 URL 中提取视频 ID: {url}")
    data = fetch_douyin_page_data(video_id)
    detail = find_aweme_detail(data)
    if not detail:
        raise RuntimeError("无法从页面数据中找到视频详情")
    info = douyin_get_info(url, detail)
    return info, detail


# ──────────────────── B站 / 通用平台 ────────────────────

def generic_get_info(url: str) -> dict:
    """用 yt-dlp 获取视频元信息"""
    raw = _ytdlp_info(url)
    return {
        "title": raw.get("title", "未知标题"),
        "author": raw.get("uploader", raw.get("creator", "未知作者")),
        "description": raw.get("description", ""),
        "duration": raw.get("duration", 0),
        "video_id": raw.get("id", ""),
        "url": url,
        "platform": raw.get("extractor", "unknown"),
    }


def generic_download(url: str, output_dir: str) -> str:
    """用 yt-dlp 下载视频"""
    return _ytdlp_download(url, output_dir)


# ───────────────────────── 语音转文字 ─────────────────────────

def transcribe_local(audio_path: str) -> str:
    """使用 faster-whisper 本地转录"""
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        raise RuntimeError("未安装 faster-whisper，请运行: pip install faster-whisper")

    model_size = os.environ.get("WHISPER_MODEL", "small")
    device = os.environ.get("WHISPER_DEVICE", "auto")
    compute_type = os.environ.get("WHISPER_COMPUTE", "int8")

    if device == "auto":
        try:
            import torch
            device = "cuda" if torch.cuda.is_available() else "cpu"
        except ImportError:
            device = "cpu"

    print(f"正在加载 Whisper 模型 ({model_size})...", file=sys.stderr)
    model = WhisperModel(model_size, device=device, compute_type=compute_type)

    print("正在转录...", file=sys.stderr)
    segments, info = model.transcribe(audio_path, language="zh", beam_size=5)

    return "".join(segment.text for segment in segments)


def transcribe_api(audio_path: str) -> str:
    """使用 OpenAI Whisper API 转录"""
    try:
        from openai import OpenAI
    except ImportError:
        raise RuntimeError("未安装 openai，请运行: pip install openai")

    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("未设置 OPENAI_API_KEY 环境变量")

    base_url = os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1")
    client = OpenAI(api_key=api_key, base_url=base_url)

    print("正在通过 API 转录...", file=sys.stderr)
    with open(audio_path, "rb") as f:
        transcript = client.audio.transcriptions.create(
            model="whisper-1", file=f, language="zh",
        )
    return transcript.text


def transcribe(audio_path: str) -> str:
    """根据配置选择转录方式"""
    mode = os.environ.get("WHISPER_MODE", "local").lower()
    if mode == "api":
        return transcribe_api(audio_path)
    return transcribe_local(audio_path)


# ───────────────────────── 主流程 ─────────────────────────

def main():
    parser = argparse.ArgumentParser(description="视频笔记生成器（支持抖音、B站等）")
    parser.add_argument("url", help="视频链接")
    parser.add_argument("--output", "-o", help="输出JSON文件路径（默认输出到stdout）")
    parser.add_argument("--skip-download", action="store_true",
                        help="跳过下载，使用已有的音频文件（需配合 --audio 指定）")
    parser.add_argument("--audio", help="指定已有的音频文件路径")
    args = parser.parse_args()

    url = args.url
    platform = detect_platform(url)
    print(f"检测到平台: {platform}", file=sys.stderr)

    # 解析短链接
    if "v.douyin.com" in url or "b23.tv" in url:
        print("正在解析短链接...", file=sys.stderr)
        url = resolve_short_url(url)
        print(f"真实链接: {url}", file=sys.stderr)

    # 国内环境自动使用 Hugging Face 镜像
    if "HF_ENDPOINT" not in os.environ:
        os.environ["HF_ENDPOINT"] = "https://hf-mirror.com"

    with tempfile.TemporaryDirectory(prefix="videonote_") as tmp_dir:
        # 获取视频信息
        print("正在获取视频信息...", file=sys.stderr)
        if platform == "douyin":
            info, detail = douyin_parse(url)
        else:
            info = generic_get_info(url)
            detail = None

        print(f"标题: {info['title']}", file=sys.stderr)
        print(f"作者: {info['author']}", file=sys.stderr)

        # 下载视频并提取音频
        if args.skip_download and args.audio:
            audio_path = args.audio
        else:
            print("正在下载视频...", file=sys.stderr)
            if platform == "douyin":
                video_path = douyin_download(url, tmp_dir, detail)
            else:
                video_path = generic_download(url, tmp_dir)
            print(f"视频已下载: {video_path}", file=sys.stderr)
            print("正在提取音频...", file=sys.stderr)
            audio_path = extract_audio(video_path, tmp_dir)

        # 语音转文字
        print("正在转录语音...", file=sys.stderr)
        transcript = transcribe(audio_path)
        info["transcript"] = transcript
        info["generated_at"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        print("转录完成!", file=sys.stderr)

    # 输出结果
    output_json = json.dumps(info, ensure_ascii=False, indent=2)

    if args.output:
        with open(args.output, "w", encoding="utf-8") as f:
            f.write(output_json)
        print(f"结果已保存到: {args.output}", file=sys.stderr)
    else:
        print(output_json)


if __name__ == "__main__":
    main()
