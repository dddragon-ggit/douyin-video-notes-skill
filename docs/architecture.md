# 视频笔记生成器 - 微信小程序方案

## 整体架构

```
┌─────────────────────────────────────────────────┐
│                 微信小程序（前端）                  │
│                                                   │
│  ┌─────────┐    ┌─────────┐    ┌──────────────┐  │
│  │ 输入链接  │ →  │ 等待转圈  │ →  │ 展示笔记结果  │  │
│  └─────────┘    └─────────┘    └──────────────┘  │
│                                      ↓            │
│                               ┌──────────────┐   │
│                               │ 历史笔记列表   │   │
│                               └──────────────┘   │
└──────────────────────┬──────────────────────────┘
                       │ wx.cloud.callFunction()
                       ▼
┌─────────────────────────────────────────────────┐
│              微信云函数（后端）                     │
│                                                   │
│  ┌──────────────────────────────────────────┐    │
│  │          processVideo 云函数               │    │
│  │                                            │    │
│  │  1. 解析短链接                              │    │
│  │  2. yt-dlp 下载视频                         │    │
│  │  3. PyAV 提取音频（云函数没有 ffmpeg）        │    │
│  │  4. 调 OpenAI Whisper API 转录              │    │
│  │  5. 调 Claude/OpenAI API 生成笔记           │    │
│  │  6. 存入云数据库                             │    │
│  │  7. 返回笔记给前端                           │    │
│  └──────────────────────────────────────────┘    │
└──────────┬────────────────┬──────────────────────┘
           │                │
           ▼                ▼
┌────────────────┐  ┌─────────────────┐
│   云数据库       │  │   外部 API       │
│                  │  │                   │
│  - 笔记记录      │  │  - OpenAI Whisper │
│  - 用户历史      │  │  - Claude / GPT   │
└────────────────┘  └─────────────────┘
```

## 核心流程（用户视角）

```
用户复制抖音/B站链接
       ↓
打开小程序，粘贴链接，点"生成笔记"
       ↓
等待 30-60 秒（转圈 + 进度提示）
       ↓
展示结构化笔记（核心要点、详细笔记、金句）
       ↓
可以查看历史笔记
```

## 云函数内部逻辑

```python
# processVideo 入口
def main(event, context):
    url = event["url"]                    # 前端传来的链接
    api_provider = event.get("api", "claude")  # 用户选择的 API

    # 第一步：下载视频
    video_bytes = download_video(url)     # yt-dlp

    # 第二步：提取音频
    audio_bytes = extract_audio(video_bytes)  # PyAV 替代 ffmpeg

    # 第三步：语音转文字
    transcript = whisper_transcribe(audio_bytes)  # OpenAI Whisper API

    # 第四步：生成笔记
    if api_provider == "claude":
        notes = claude_generate(transcript)   # Anthropic API
    else:
        notes = openai_generate(transcript)   # OpenAI API

    # 第五步：存储并返回
    save_to_db(url, notes)
    return notes
```

## 需要配置的东西

| 配置项 | 说明 |
|--------|------|
| 微信小程序 AppID | 微信公众平台申请 |
| 云开发环境 | 小程序后台开通 |
| OpenAI API Key | Whisper 转录 + 可选笔记生成 |
| Anthropic API Key | Claude 生成笔记（可选） |

## 免费额度

| 资源 | 免费额度 | 每次消耗 |
|------|----------|----------|
| 云函数调用 | 4万次/月 | 1次 |
| 数据库容量 | 2GB | ~5KB/条 |
| 数据库读 | 5万次/月 | 2-3次 |
| 云存储 | 5GB | 临时音频 ~2MB |

个人用完全够。

## 文件结构

```
miniprogram/
├── pages/
│   ├── index/          # 首页（输入链接）
│   └── result/         # 结果页（展示笔记）
├── cloudfunctions/
│   └── processVideo/   # 核心云函数
│       └── index.py
├── app.js
├── app.json
└── project.config.json
```
