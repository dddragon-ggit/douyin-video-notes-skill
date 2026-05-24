视频笔记生成工具。当用户提供视频链接时，自动下载视频、转录语音、生成结构化笔记。

## 支持平台

- **抖音**：分享链接、短链接（v.douyin.com）、分享文本粘贴
- **B站**：视频链接（bilibili.com）、短链接（b23.tv）
- **其他平台**：yt-dlp 支持的所有平台（YouTube、微博等）

## 使用方式

用户输入: `/douyin-notes <视频链接>`

`$ARGUMENTS` 是用户提供的视频链接或包含链接的分享文本。

## 执行步骤

### 第 1 步：环境检查与依赖安装

运行以下命令检查并安装依赖：

```bash
pip install yt-dlp faster-whisper openai requests
```

检查 ffmpeg 是否可用：

```bash
ffmpeg -version 2>&1 | head -1
```

如果 ffmpeg 未安装，提示用户：
- Windows: `winget install ffmpeg` 或从 https://ffmpeg.org/download.html 下载
- macOS: `brew install ffmpeg`
- Linux: `sudo apt install ffmpeg`

### 第 2 步：运行转录脚本

**重要**：必须将结果保存到文件，直接输出到 stdout 会因编码问题导致中文乱码。

```bash
python douyin_notes.py "$ARGUMENTS" -o output.json
```

脚本会自动检测平台并选择对应策略：
- **抖音**：解析分享页面获取视频（无需 cookies）
- **B站/其他**：使用 yt-dlp 下载
- 国内环境自动使用 hf-mirror.com 镜像下载 Whisper 模型

如果转录失败，检查错误信息：
- 网络超时：检查是否需要设置代理
- 模型下载失败：手动设置 `HF_ENDPOINT=https://hf-mirror.com`
- 切换到 API 模式：`WHISPER_MODE=api OPENAI_API_KEY=sk-xxx python douyin_notes.py <url>`

### 第 3 步：读取转录结果并生成笔记

读取 `output.json` 文件，根据转录文本生成结构化笔记。

笔记格式：

```markdown
# {视频标题}

> 作者：{作者}
> 链接：{原始链接}

## 核心要点

（用 3-5 个要点概括视频核心内容）

## 详细笔记

（按视频内容的逻辑结构，分段整理详细笔记，使用标题和列表）

## 金句摘录

（提取视频中的精彩语句或关键论断）

---
*生成时间：{当前日期时间}*
```

### 第 4 步：保存笔记并清理

将笔记保存到 `notes/` 目录，文件名格式为 `{YYYY-MM-DD}_{视频标题简写}.md`（标题取前 20 个字符，特殊字符替换为下划线）。

删除临时文件 `output.json`。

告知用户笔记文件路径。

## 环境变量说明

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `WHISPER_MODE` | `local` | `local` 用本地模型，`api` 用 OpenAI Whisper API |
| `WHISPER_MODEL` | `small` | 本地模型大小：tiny / base / small / medium / large-v3 |
| `HF_ENDPOINT` | 自动设为 `hf-mirror.com` | Hugging Face 镜像地址（国内环境自动设置） |
| `OPENAI_API_KEY` | - | API 模式下的 OpenAI 密钥 |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | API 模式下的 base URL（可改为兼容接口） |
