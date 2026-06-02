const cloud = require("wx-server-sdk");
const tencentcloud = require("tencentcloud-sdk-nodejs");
const https = require("https");
const http = require("http");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

// ── 配置 ──────────────────────────────────────────────
const ALLOWED_OPENID = "oaEY53W1Ytbv2opj7HfTaqedXYeg";
const TENCENT_SECRET_ID = process.env.TENCENT_SECRET_ID || "";
const TENCENT_SECRET_KEY = process.env.TENCENT_SECRET_KEY || "";
const BASE_URL = process.env.BASE_URL || "";
const API_KEY = process.env.API_KEY || "";
const MODEL = process.env.MODEL || "";

const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

// ── HTTP 工具（带重试） ───────────────────────────────
function httpGet(url, headers = {}, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) return reject(new Error("重定向次数过多"));
    const mod = url.startsWith("https") ? https : http;
    const req = mod.get(url, { headers: { "User-Agent": UA, ...headers }, timeout: 15000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpGet(res.headers.location, headers, maxRedirects - 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error("HTTP " + res.statusCode + ": " + url.slice(0, 80)));
      }
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve(data));
    });
    req.on("error", (e) => reject(new Error("网络请求失败: " + e.message)));
    req.on("timeout", () => { req.destroy(); reject(new Error("请求超时(15s)")); });
  });
}

// 获取短链接的重定向目标（只获取 URL，不下载内容）
function getRedirectUrl(url, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) return reject(new Error("重定向次数过多"));
    const mod = url.startsWith("https") ? https : http;
    const req = mod.get(url, { headers: { "User-Agent": UA }, timeout: 10000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return getRedirectUrl(res.headers.location, maxRedirects - 1).then(resolve, reject);
      }
      // 返回当前请求的完整 URL
      resolve(res.req?.res?.responseUrl || res.headers.location || url);
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("重定向超时")); });
  });
}

function httpsPost(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error("无效 URL: " + url)); }
    const payload = JSON.stringify(body);
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload), ...headers },
        timeout: 50000,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.on("error", (e) => reject(new Error("POST 请求失败: " + e.message)));
    req.on("timeout", () => { req.destroy(); reject(new Error("POST 请求超时(60s)")); });
    req.write(payload);
    req.end();
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ── 重试包装 ──────────────────────────────────────────
async function withRetry(fn, maxRetries = 2, delayMs = 2000) {
  let lastErr;
  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      console.log(`重试 ${i}/${maxRetries}: ${e.message}`);
      if (i < maxRetries) await sleep(delayMs);
    }
  }
  throw lastErr;
}

// ── 腾讯云 ASR ────────────────────────────────────────
const AsrClient = tencentcloud.asr.v20190614.Client;
function createAsrClient() {
  if (!TENCENT_SECRET_ID || !TENCENT_SECRET_KEY) throw new Error("未配置腾讯云密钥");
  return new AsrClient({
    credential: { secretId: TENCENT_SECRET_ID, secretKey: TENCENT_SECRET_KEY },
    region: "ap-guangzhou",
  });
}

// ── 云函数入口 ────────────────────────────────────────
exports.main = async (event) => {
  const { action } = event;

  // ── 访问控制：仅允许指定用户 ─────────────────────────
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID || event.userInfo?.openId || "";
  console.log("调用者 openid:", openid, "action:", action);
  if (openid !== ALLOWED_OPENID) {
    console.log("未授权访问, openid:", openid);
    return { success: false, error: "未授权用户，无法使用此服务" };
  }

  console.log("收到请求, action:", action);

  try {
    switch (action) {
      case "parseVideo":
        return await parseVideo(event.url);
      case "downloadAndUpload":
        return await downloadAndUpload(event.videoUrl, event.extraHeaders);
      case "startASR":
        return await startASR(event.audioUrl);
      case "checkASR":
        return await checkASRResult(event.taskId);
      case "generateAndSave":
        return await generateAndSave(event.transcript, event.info, event.url, event.apiConfig || {});
      case "saveNote":
        return await saveNoteOnly(event.info, event.noteContent, event.url, event.category);
      case "updateNoteCategory":
        return await updateNoteCategory(event.noteId, event.category);
      case "clearCategoryNotes":
        return await clearCategoryNotes(event.oldCategory);
      case "renameCategoryNotes":
        return await renameCategoryNotes(event.oldName, event.newName);
      case "updateNoteStar":
        return await updateNoteStar(event.noteId, event.starred);
      case "deleteNote":
        return await deleteNote(event.noteId);
      case "updateNoteMemo":
        return await updateNoteMemo(event.noteId, event.memo);
      case "deleteCloudFile":
        return await deleteCloudFile(event.fileID);
      case "generateFromText":
        return await generateFromText(event.text, event.title, event.apiConfig || {});
      default:
        return { success: false, error: "未知 action: " + action };
    }
  } catch (e) {
    console.error("处理失败:", e.message, e.stack);
    return { success: false, error: e.message || "处理失败" };
  }
};

// ── 第 1 步：解析视频页面 ─────────────────────────────
async function parseVideo(url) {
  if (!url || typeof url !== "string") {
    return { success: false, error: "请提供有效的视频链接" };
  }
  url = url.trim();
  if (!url.startsWith("http")) {
    return { success: false, error: "链接格式不正确，请粘贴完整 URL" };
  }

  try {
    if (url.includes("douyin") || url.includes("iesdouyin")) {
      return await parseDouyin(url);
    }
    if (url.includes("bilibili.com") || url.includes("b23.tv")) {
      return await parseBilibili(url);
    }
    return await parseGeneric(url);
  } catch (e) {
    console.error("解析失败:", e.message);
    return { success: false, error: "视频解析失败: " + e.message };
  }
}

async function parseDouyin(url) {
  const html = await httpGet(url, { Referer: "https://www.douyin.com/" });
  if (!html || html.length < 500) {
    return { success: false, error: "抖音返回了空页面，请检查链接是否正确" };
  }

  const match = html.match(/window\._ROUTER_DATA\s*=\s*(\{.+?\})\s*<\/script>/s);
  if (!match) {
    return { success: false, error: "无法解析抖音页面，页面结构可能已更新" };
  }

  let data;
  try {
    data = JSON.parse(match[1]);
  } catch (e) {
    return { success: false, error: "抖音页面数据解析失败" };
  }

  let detail = null;
  function findDetail(obj) {
    if (detail || !obj) return;
    if (typeof obj === "object" && !Array.isArray(obj)) {
      if (obj.aweme && typeof obj.aweme === "object") { detail = obj.aweme; return; }
      if (obj.desc && obj.author && obj.video) { detail = obj; return; }
      for (const v of Object.values(obj)) findDetail(v);
    } else if (Array.isArray(obj)) {
      for (const item of obj) findDetail(item);
    }
  }
  findDetail(data);

  if (!detail) {
    return { success: false, error: "未找到视频信息，可能需要登录或视频已删除" };
  }

  const videoUrl = detail.video?.play_addr?.url_list?.[0];
  if (!videoUrl) {
    return { success: false, error: "未找到视频播放地址" };
  }

  return {
    success: true,
    videoUrl,
    info: {
      title: String(detail.desc || "未知标题").slice(0, 100),
      author: String(detail.author?.nickname || "未知作者"),
      platform: "抖音",
      duration: Math.floor((detail.duration || 0) / 1000),
    },
  };
}

async function parseBilibili(url) {
  const biliHeaders = {
    "User-Agent": UA,
    "Referer": "https://www.bilibili.com/",
  };

  // 如果是 b23.tv 短链接，先跟随重定向获取真实 URL
  if (url.includes("b23.tv")) {
    console.log("解析 B站短链接:", url);
    try {
      const realUrl = await getRedirectUrl(url);
      console.log("真实 URL:", realUrl);
      url = realUrl || url;
    } catch (e) {
      return { success: false, error: "B站短链接解析失败，请使用完整链接" };
    }
  }

  // 提取 BV 号
  const bvMatch = url.match(/(BV[\w]+)/);
  if (!bvMatch) return { success: false, error: "无法从链接中提取 B站视频 ID，请使用 bilibili.com/video/BVxxx 格式" };
  const bvid = bvMatch[1];

  // 获取视频信息
  const infoUrl = `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`;
  const infoRes = await httpGet(infoUrl, biliHeaders);
  let infoData;
  try { infoData = JSON.parse(infoRes); } catch (e) {
    return { success: false, error: "B站 API 返回格式异常" };
  }
  if (infoData.code !== 0) {
    return { success: false, error: "B站 API 错误: " + (infoData.message || infoData.code) };
  }

  const vid = infoData.data;
  const cid = vid.cid;
  const title = String(vid.title || "未知标题").slice(0, 100);
  const author = vid.owner?.name || "未知作者";
  const duration = vid.duration || 0;

  // 从云函数调 playurl API，返回多个 CDN URL 让手机端尝试
  try {
    const playUrl = `https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&qn=32&fnval=16`;
    const playRes = await httpGet(playUrl, biliHeaders);
    let playData;
    try { playData = JSON.parse(playRes); } catch (e) {
      return { success: true, needClientDownload: true, biliApiInfo: { bvid, cid, title, author, duration }, info: { title, author, platform: "B站", duration } };
    }
    if (playData.code !== 0) {
      return { success: true, needClientDownload: true, biliApiInfo: { bvid, cid, title, author, duration }, info: { title, author, platform: "B站", duration } };
    }

    const dash = playData.data?.dash;
    const audioList = (dash?.audio || []).map(a => ({
      url: a.baseUrl || a.base_url,
      backupUrls: a.backupUrl || a.backup_url || [],
    }));

    // 收集所有可用的 CDN URL（原 URL + 备用 URL）
    const allUrls = [];
    for (const audio of audioList) {
      if (audio.url) allUrls.push(audio.url);
      if (audio.backupUrls) {
        for (const bu of audio.backupUrls) {
          if (bu) allUrls.push(bu);
        }
      }
    }

    return {
      success: true,
      needClientDownload: true,
      biliApiInfo: { bvid, cid, title, author, duration },
      downloadUrls: allUrls.slice(0, 6),
      info: { title, author, platform: "B站", duration },
    };
  } catch (e) {
    console.log("B站 API 调用失败，降级到手机端:", e.message);
    return { success: true, needClientDownload: true, biliApiInfo: { bvid, cid, title, author, duration }, info: { title, author, platform: "B站", duration } };
  }
}

async function parseGeneric(url) {
  const info = { title: "视频笔记", author: "未知作者", platform: "其他", duration: 0 };
  try {
    const html = await httpGet(url);
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (titleMatch) info.title = titleMatch[1].trim().slice(0, 100);
  } catch (e) {
    console.log("获取标题失败:", e.message);
  }
  return { success: true, videoUrl: url, info };
}

// ── 第 2 步：下载视频并上传到云存储 ──────────────────
async function downloadAndUpload(videoUrl, extraHeaders) {
  if (!videoUrl || typeof videoUrl !== "string") {
    return { success: false, error: "缺少视频地址" };
  }

  const cloudPath = "videos/" + Date.now() + "_" + Math.random().toString(36).slice(2, 6) + ".mp4";
  console.log("开始下载:", videoUrl.slice(0, 100));

  try {
    const fileStream = await downloadToStream(videoUrl, extraHeaders);
    console.log("下载完成，开始上传到云存储...");

    const uploadRes = await cloud.uploadFile({
      cloudPath,
      fileContent: fileStream,
    });
    console.log("上传完成, fileID:", uploadRes.fileID);

    const urlRes = await cloud.getTempFileURL({ fileList: [uploadRes.fileID] });
    if (!urlRes.fileList || !urlRes.fileList[0] || !urlRes.fileList[0].tempFileURL) {
      return { success: false, error: "获取云存储临时链接失败" };
    }

    const tempUrl = urlRes.fileList[0].tempFileURL;
    console.log("临时 URL 获取成功");
    return { success: true, publicUrl: tempUrl, fileID: uploadRes.fileID };
  } catch (e) {
    console.error("下载/上传失败:", e.message);
    return { success: false, error: "视频下载失败: " + e.message };
  }
}

function downloadToStream(url, extraHeaders, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) return reject(new Error("重定向次数过多"));
    const mod = url.startsWith("https") ? https : http;
    const isBili = extraHeaders?.Referer?.includes("bilibili");
    const headers = extraHeaders?.Referer
      ? {
          "User-Agent": UA,
          "Referer": extraHeaders.Referer,
          "Origin": extraHeaders.Origin || extraHeaders.Referer,
          "Accept": "*/*",
          "Accept-Language": "zh-CN,zh;q=0.9",
          ...(isBili ? { "Range": "bytes=0-" } : {}),
        }
      : { "User-Agent": UA, Referer: "https://www.douyin.com/" };
    const req = mod.get(url, {
      headers,
      timeout: 55000,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadToStream(res.headers.location, extraHeaders, maxRedirects - 1).then(resolve, reject);
      }
      if (res.statusCode !== 200 && res.statusCode !== 206) {
        return reject(new Error("下载失败: HTTP " + res.statusCode));
      }
      const size = parseInt(res.headers["content-length"] || "0", 10);
      if (size > 500 * 1024 * 1024) {
        return reject(new Error("视频文件过大(>500MB)，暂不支持"));
      }
      console.log("视频大小:", size ? (size / 1024 / 1024).toFixed(1) + "MB" : "未知");
      resolve(res);
    });
    req.on("error", (e) => reject(new Error("下载网络错误: " + e.message)));
    req.on("timeout", () => { req.destroy(); reject(new Error("下载超时(55s)，视频可能过大")); });
  });
}

// ── 第 3 步：创建 ASR 任务 ────────────────────────────
async function startASR(audioUrl) {
  if (!audioUrl) return { success: false, error: "缺少音频地址" };

  try {
    const client = createAsrClient();
    console.log("创建 ASR 任务, URL:", audioUrl.slice(0, 100));
    const res = await client.CreateRecTask({
      EngineModelType: "16k_zh",
      ChannelNum: 1,
      ResTextFormat: 1,
      SourceType: 0,
      Url: audioUrl,
    });
    if (!res.Data || !res.Data.TaskId) {
      return { success: false, error: "ASR 创建任务失败: " + JSON.stringify(res) };
    }
    console.log("ASR 任务创建成功, TaskId:", res.Data.TaskId);
    return { success: true, asrTaskId: res.Data.TaskId };
  } catch (e) {
    console.error("ASR 创建失败:", e.message);
    return { success: false, error: "ASR 任务创建失败: " + e.message };
  }
}

// ── 第 4 步：检查 ASR 结果 ────────────────────────────
async function checkASRResult(taskId) {
  if (!taskId) return { success: false, error: "缺少 taskId" };

  try {
    const client = createAsrClient();
    const statusRes = await client.DescribeTaskStatus({ TaskId: taskId });
    if (!statusRes || !statusRes.Data) {
      return { success: false, error: "查询 ASR 状态失败" };
    }

    const status = statusRes.Data.Status;
    console.log("ASR 状态:", status);

    if (status === 2) {
      // 成功
      const raw = statusRes.Data.Result;
      let transcript = "";

      if (typeof raw === "object" && raw !== null) {
        transcript = (raw.sentence || []).map((s) => s.text || "").join("");
      } else if (typeof raw === "string") {
        try {
          const parsed = JSON.parse(raw);
          transcript = (parsed.sentence || []).map((s) => s.text || "").join("");
        } catch (e) {
          transcript = raw.replace(/\[\d+:\d+\.\d+,\d+:\d+\.\d+\]\s*/g, "").trim();
        }
      }

      if (!transcript) {
        return { success: false, error: "ASR 返回了空结果，视频可能没有语音内容" };
      }
      return { success: true, status: "done", transcript };
    }

    if (status === 3) {
      const errMsg = statusRes.Data.ErrorMsg || statusRes.Data.StatusStr || "未知错误";
      console.error("ASR 失败:", errMsg);
      return { success: false, status: "failed", error: "语音转录失败: " + errMsg };
    }

    return { success: true, status: "processing" };
  } catch (e) {
    console.error("查询 ASR 状态异常:", e.message);
    return { success: false, error: "查询 ASR 状态失败: " + e.message };
  }
}

// ── 第 5a 步：生成笔记（LLM 调用） ────────────────────
async function generateAndSave(transcript, info, url, apiConfig) {
  if (!transcript || typeof transcript !== "string") {
    return { success: false, error: "缺少转录内容" };
  }
  if (!info || !info.title) {
    return { success: false, error: "缺少视频信息" };
  }

  try {
    const noteContent = await generateNotes(transcript, info, apiConfig);
    return { success: true, noteContent };
  } catch (e) {
    console.error("笔记生成失败:", e.message);
    return { success: false, error: "笔记生成失败: " + e.message };
  }
}

// ── 第 5b 步：保存笔记到数据库 ────────────────────────
async function saveNoteOnly(info, noteContent, url, category, memo) {
  if (!noteContent) return { success: false, error: "缺少笔记内容" };
  if (!info || !info.title) return { success: false, error: "缺少视频信息" };

  try {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const generatedAt = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

    // 在笔记内容前拼接链接和便签
    let prefix = "";
    if (url) prefix += "🔗 [视频链接](" + url + ")\n\n";
    if (memo) prefix += "📝 " + memo + "\n\n";
    const fullMarkdown = prefix + noteContent;

    const dbRes = await db.collection("notes").add({
      data: {
        title: info.title,
        author: info.author || "未知作者",
        platform: info.platform || "其他",
        duration: info.duration || 0,
        url: url || "",
        detail_markdown: fullMarkdown,
        category: category || "",
        starred: false,
        memo: memo || "",
        created_at: db.serverDate(),
        generated_at: generatedAt,
      },
    });
    console.log("笔记保存成功, ID:", dbRes._id);
    return { success: true, noteId: dbRes._id };
  } catch (e) {
    console.error("保存笔记失败:", e.message);
    return { success: false, error: "笔记保存失败: " + e.message };
  }
}

// ── 分类管理（服务端操作，绕过权限限制） ──────────────
async function updateNoteCategory(noteId, category) {
  if (!noteId) return { success: false, error: "缺少笔记 ID" };
  try {
    await db.collection("notes").doc(noteId).update({ data: { category: category || "" } });
    return { success: true };
  } catch (e) {
    console.error("更新笔记分类失败:", e.message);
    return { success: false, error: "更新失败: " + e.message };
  }
}

async function clearCategoryNotes(oldCategory) {
  if (!oldCategory) return { success: false, error: "缺少分类名" };
  try {
    const res = await db.collection("notes").where({ category: oldCategory }).get();
    const notes = res.data || [];
    for (const note of notes) {
      await db.collection("notes").doc(note._id).update({ data: { category: "" } });
    }
    return { success: true, count: notes.length };
  } catch (e) {
    console.error("清空分类笔记失败:", e.message);
    return { success: false, error: "操作失败: " + e.message };
  }
}

async function renameCategoryNotes(oldName, newName) {
  if (!oldName || !newName) return { success: false, error: "缺少分类名" };
  try {
    const res = await db.collection("notes").where({ category: oldName }).get();
    const notes = res.data || [];
    for (const note of notes) {
      await db.collection("notes").doc(note._id).update({ data: { category: newName } });
    }
    return { success: true, count: notes.length };
  } catch (e) {
    console.error("重命名分类笔记失败:", e.message);
    return { success: false, error: "操作失败: " + e.message };
  }
}

async function deleteCloudFile(fileID) {
  if (!fileID) return { success: false, error: "缺少 fileID" };
  try {
    await cloud.deleteFile({ fileList: [fileID] });
    console.log("已删除云存储文件:", fileID);
    return { success: true };
  } catch (e) {
    console.error("删除云存储文件失败:", e.message);
    return { success: false, error: e.message };
  }
}

async function updateNoteStar(noteId, starred) {
  if (!noteId) return { success: false, error: "缺少笔记 ID" };
  try {
    await db.collection("notes").doc(noteId).update({ data: { starred: !!starred } });
    return { success: true };
  } catch (e) {
    console.error("更新星标失败:", e.message);
    return { success: false, error: "操作失败: " + e.message };
  }
}

async function deleteNote(noteId) {
  if (!noteId) return { success: false, error: "缺少笔记 ID" };
  try {
    await db.collection("notes").doc(noteId).remove();
    return { success: true };
  } catch (e) {
    console.error("删除笔记失败:", e.message);
    return { success: false, error: "删除失败: " + e.message };
  }
}

async function updateNoteMemo(noteId, memo) {
  if (!noteId) return { success: false, error: "缺少笔记 ID" };
  try {
    const res = await db.collection("notes").doc(noteId).get();
    const note = res.data;
    if (!note) return { success: false, error: "笔记不存在" };

    // 重新拼接 detail_markdown 前缀：链接 + 便签 + 原始笔记内容
    const rawContent = stripPrefix(note.detail_markdown || "");
    let prefix = "";
    if (note.url) prefix += "🔗 [视频链接](" + note.url + ")\n\n";
    if (memo) prefix += "📝 " + memo + "\n\n";
    const fullMarkdown = prefix + rawContent;

    await db.collection("notes").doc(noteId).update({
      data: { memo: memo || "", detail_markdown: fullMarkdown },
    });
    return { success: true };
  } catch (e) {
    console.error("更新便签失败:", e.message);
    return { success: false, error: "操作失败: " + e.message };
  }
}

// 从 detail_markdown 中剥离 🔗 链接行和 📝 便签行，返回原始笔记内容
function stripPrefix(md) {
  let content = md;
  // 剥离开头的 🔗 链接行
  content = content.replace(/^🔗\s*\[视频链接\]\(https?:\/\/[^\)]+\)\n*/g, "");
  // 剥离开头的 📝 便签行（可能多行）
  content = content.replace(/^📝\s*.+\n*/gm, "");
  return content.trimStart();
}

async function generateNotes(transcript, info, apiConfig) {
  const defaults = {
    baseUrl: BASE_URL,
    apiKey: API_KEY,
    model: MODEL,
    format: "openai",
  };
  const cfg = Object.assign(defaults, apiConfig || {});

  if (!cfg.apiKey) throw new Error("未配置 API Key，请在设置中填写");
  if (!cfg.baseUrl) throw new Error("未配置 API 地址，请在设置中填写");

  const prompt = `你是一个专业的笔记助手。请根据以下内容生成结构化的详细笔记。

标题：${info.title}
来源：${info.author}（${info.platform}）

内容：
${transcript.slice(0, 6000)}

请生成以下格式的笔记（使用 Markdown）：

## 核心要点
（列出 3-5 个核心要点，每个要点包含标题和 1-2 句详细说明）

## 详细笔记
（这是最重要的部分。按主题分段，每段要深入展开：
- 涉及具体方法、策略、步骤的内容，要完整列出，不要省略
- 技术细节要写清楚原理和操作步骤
- 数据、案例、对比分析要保留并展开说明
- 如果有操作流程或方法论，用编号列表逐步展开）

## 金句摘录
（提取 3-5 句有启发性或有指导意义的原话）

## 总结
（用 3-5 句话总结核心观点和可执行的行动建议）`;

  let res;
  if (cfg.format === "anthropic") {
    // Anthropic Messages API 格式
    const apiHost = new URL(cfg.baseUrl).host;
    res = await httpsPost(
      `${cfg.baseUrl}/messages`,
      {
        model: cfg.model,
        max_tokens: 4096,
        system: "你是一个专业的笔记助手，擅长生成详细、深入的结构化笔记。",
        messages: [{ role: "user", content: prompt }],
      },
      {
        "x-api-key": cfg.apiKey,
        "anthropic-version": "2023-06-01",
      }
    );
    const data = JSON.parse(res.body);
    if (data.error) throw new Error("Anthropic API 错误: " + (data.error.message || JSON.stringify(data.error)));
    if (!data.content || data.content.length === 0) throw new Error("Anthropic 返回了空结果");
    const textBlock = data.content.find(b => b.type === "text");
    if (!textBlock) throw new Error("Anthropic 返回格式异常");
    return textBlock.text;
  }

  // OpenAI 兼容格式（默认）
  res = await httpsPost(
    `${cfg.baseUrl}/chat/completions`,
    {
      model: cfg.model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 4096,
      temperature: 0.7,
    },
    { Authorization: `Bearer ${cfg.apiKey}` }
  );

  if (res.status !== 200) {
    throw new Error("LLM API 返回 HTTP " + res.status + ": " + res.body.slice(0, 200));
  }

  let data;
  try { data = JSON.parse(res.body); } catch (e) {
    throw new Error("LLM API 返回格式异常");
  }
  if (data.error) throw new Error("LLM 错误: " + (data.error.message || JSON.stringify(data.error)));
  if (!data.choices || !data.choices[0] || !data.choices[0].message) throw new Error("LLM 返回了空结果");
  return data.choices[0].message.content;
}

// ── 文本笔记生成 ────────────────────────────────────
async function generateFromText(text, title, apiConfig) {
  if (!text || typeof text !== "string" || text.trim().length < 10) {
    return { success: false, error: "请输入至少 10 个字的内容" };
  }

  const noteTitle = (title && title.trim()) || "文本笔记";
  const info = { title: noteTitle, author: "用户输入", platform: "文本笔记" };

  try {
    const noteContent = await generateNotes(text.trim(), info, apiConfig);
    return { success: true, noteContent };
  } catch (e) {
    console.error("文本笔记生成失败:", e.message);
    return { success: false, error: "笔记生成失败: " + e.message };
  }
}
