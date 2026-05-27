# 视频笔记小程序 - 配置与部署指南

## 目录
1. [前置准备](#1-前置准备)
2. [注册微信小程序](#2-注册微信小程序)
3. [开通云开发](#3-开通云开发)
4. [申请腾讯云 ASR](#4-申请腾讯云-asr)
5. [准备 LLM API](#5-准备-llm-api)
6. [创建云函数与数据库](#6-创建云函数与数据库)
7. [配置环境变量](#7-配置环境变量)
8. [配置访问控制](#8-配置访问控制)
9. [发布体验版](#9-发布体验版)

---

## 1. 前置准备

- 微信账号（用于注册小程序）
- 微信开发者工具：https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html
- 腾讯云账号（用于 ASR 语音转文字）
- 一个 OpenAI 兼容格式或 Anthropic 格式的 LLM API

---

## 2. 注册微信小程序

### 2.1 注册
1. 打开 https://mp.weixin.qq.com
2. 点击右上角「立即注册」→ 选择「小程序」
3. 用邮箱注册，完成邮箱验证
4. 填写主体信息（个人即可）
5. 注册完成后进入小程序后台

### 2.2 获取 AppID
1. 登录 https://mp.weixin.qq.com
2. 左侧菜单「开发」→「开发管理」→「开发设置」
3. 找到 **AppID（小程序ID）**，记录下来，格式如 `wxbdce5ebb102bbd70`

### 2.3 配置开发者工具
1. 打开微信开发者工具
2. 新建项目，填入刚获取的 AppID
3. 后端服务选择「微信云开发」
4. 项目目录选择本项目的根目录

---

## 3. 开通云开发

### 3.1 创建云环境
1. 在开发者工具中，点击左上角「云开发」按钮
2. 首次使用会提示开通，点击「开通」
3. 创建环境，环境 ID 类似 `cloudbase-xxxxxxxx`，记录下来
4. 免费额度足够个人使用

### 3.2 创建数据库集合
在云开发控制台 → 数据库中，创建以下集合：

| 集合名 | 用途 | 权限设置 |
|--------|------|---------|
| `notes` | 存储笔记数据 | 所有用户可读，仅创建者可读写 |

> 注意：权限设置为「所有用户可读，仅创建者可读写」即可，因为写入操作通过云函数完成（有管理员权限）。

---

## 4. 申请腾讯云 ASR

ASR（自动语音识别）用于将视频音频转为文字。

### 4.1 注册腾讯云
1. 打开 https://cloud.tencent.com
2. 用微信扫码注册并完成实名认证

### 4.2 开通语音识别服务
1. 进入腾讯云控制台
2. 搜索「语音识别」或访问 https://console.cloud.tencent.com/asr
3. 点击「开通服务」
4. 新用户有 **免费 10 小时/月** 的额度

### 4.3 获取 API 密钥
1. 访问 https://console.cloud.tencent.com/cam/capi
2. 点击「新建密钥」
3. 记录 **SecretId** 和 **SecretKey**
   - SecretId 格式如 `AKIDxxxxxxxx`
   - SecretKey 格如 `xxxxxxxxxxxxxxxx`

### 4.4 费用说明
| 用量 | 费用 |
|------|------|
| 每月前 10 小时 | 免费 |
| 超出部分 | 约 0.6 元/小时 |

---

## 5. 准备 LLM API

本应用支持两种 API 格式，任选其一。

### 5.1 OpenAI 兼容格式
适用于：OpenAI、通义千问、智谱、Moonshot、DeepSeek 等

需要的信息：
- **Base URL**：如 `https://api.openai.com/v1`
- **API Key**：如 `sk-xxxxxxxx`
- **模型名**：如 `gpt-4o`、`deepseek-chat`

### 5.2 Anthropic 格式
适用于：Claude 系列模型

需要的信息：
- **Base URL**：如 `https://api.anthropic.com`
- **API Key**：如 `sk-ant-xxxxxxxx`
- **模型名**：如 `claude-sonnet-4-6`

> 用户可在小程序「设置」页面自行配置和切换 API，无需修改代码。

---

## 6. 创建云函数与数据库

### 6.1 部署云函数
1. 在开发者工具中，找到 `cloudfunctions/processVideo` 文件夹
2. 右键 → 「上传并部署：云端安装依赖」
3. 等待部署完成（约 1-2 分钟）
4. **每次修改云函数代码后，都需要重新部署**

### 6.2 验证云函数
部署完成后，在开发者工具 Console 中运行：
```js
wx.cloud.callFunction({
  name: 'processVideo',
  data: { action: 'test' }
}).then(r => console.log(r))
```
如果返回 `{success: false, error: "未授权用户"}`，说明访问控制已生效（OpenID 不匹配时）。

---

## 7. 配置环境变量

环境变量用于存放敏感信息，避免硬编码在代码中。

### 7.1 设置环境变量
1. 云开发控制台 → 云函数 → 找到 `processVideo`
2. 点击函数名进入详情 → 「编辑」→「环境变量」
3. 添加以下变量：

| 变量名 | 说明 | 示例值 |
|--------|------|--------|
| `TENCENT_SECRET_ID` | 腾讯云 SecretId | `AKIDxxxxxxxx` |
| `TENCENT_SECRET_KEY` | 腾讯云 SecretKey | `xxxxxxxx` |
| `BASE_URL` | LLM API 地址 | `https://api.openai.com/v1` |
| `API_KEY` | LLM API 密钥 | `sk-xxxxxxxx` |
| `MODEL` | 默认模型名 | `gpt-4o` |

> 这些是默认值。用户在小程序「设置」页面填写的配置会覆盖这些默认值。

### 7.2 本地开发配置（可选）
如果需要本地调试，创建 `miniprogram/config/secrets.js`：
```js
module.exports = {
  TENCENT_SECRET_ID: "你的SecretId",
  TENCENT_SECRET_KEY: "你的SecretKey",
};
```
此文件已被 `.gitignore` 忽略，不会上传到仓库。

---

## 8. 配置访问控制

确保只有你一个人能使用此应用。

### 8.1 确认你的 OpenID
1. 在开发者工具 Console 中运行：
```js
wx.cloud.callFunction({
  name: 'processVideo',
  data: { action: 'test' }
}).then(r => console.log(r))
```
2. 如果返回"未授权"，在控制台日志中找到你的 OpenID
3. 打开 `cloudfunctions/processVideo/index.js`，修改第 10 行：
```js
const ALLOWED_OPENID = "你的OpenID";
```
4. 重新部署云函数

### 8.2 工作原理
- 每次调用云函数时，微信自动附带调用者的 OpenID
- 云函数检查 OpenID 是否匹配，不匹配则拒绝
- 即使别人意外打开了小程序，也无法使用任何功能

---

## 9. 发布体验版

### 9.1 上传代码
1. 开发者工具右上角点击「上传」
2. 版本号填 `1.0.0`，备注随意
3. 上传成功后，进入 https://mp.weixin.qq.com

### 9.2 设置体验版
1. 登录微信公众平台（用注册小程序的微信号扫码）
2. 左侧菜单「管理」→「版本管理」
3. 在「开发版本」中找到刚上传的版本
4. 点击「设为体验版」，页面路径填 `pages/chat/chat`
5. 会生成一个二维码

### 9.3 使用体验版
1. 微信扫描体验版二维码
2. 点击右上角「...」→「添加到我的小程序」
3. 以后从微信下拉列表 → 「我的小程序」中直接打开
4. 选择「体验版」（不是「开发版」）

> 体验版无需审核，不会过期，可永久使用。不需要提交审核或发布。

---

## 常见问题

### Q: 部署云函数时提示"找不到云函数"
A: 确认 `project.config.json` 中 `cloudfunctionRoot` 指向 `cloudfunctions/`，且该文件夹下有 `processVideo` 文件夹。

### Q: ASR 语音转录失败
A: 检查腾讯云 SecretId/SecretKey 是否正确，以及免费额度是否用完。

### Q: 笔记生成失败
A: 检查 LLM API 配置是否正确，可在「设置」页面修改后重试。

### Q: 分类功能不生效
A: 确保云函数已重新部署（包含最新的分类管理 action）。

### Q: 别人能用我的小程序吗
A: 不能。体验版只有你自己能访问，且云函数有 OpenID 访问控制。
