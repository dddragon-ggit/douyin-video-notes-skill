const db = wx.cloud.database();
const STORAGE_KEY = "apiConfig";

const URL_REGEX = /https?:\/\/[^\s]+/;

function extractUrl(text) {
    const match = text.match(URL_REGEX);
    return match ? match[0] : null;
}

function genId() {
    return 'msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
}

function getApiConfig() {
    return wx.getStorageSync(STORAGE_KEY) || {};
}

Page({
    data: {
        messages: [],
        inputValue: '',
        isProcessing: false,
        scrollToId: '',
    },

    onLoad(options) {
        this.addMessage({
            type: 'system',
            content: '欢迎使用视频笔记助手！发送抖音或B站链接，我帮你生成结构化笔记。',
        });
        // 从详情页"重新生成"跳转过来时自动触发
        if (options.url) {
            const url = decodeURIComponent(options.url);
            this.setData({ inputValue: url });
            setTimeout(() => this.sendMessage(), 300);
        }
    },

    onInput(e) {
        this.setData({ inputValue: e.detail.value });
    },

    // 长按复制
    copyText(e) {
        const text = e.currentTarget.dataset.text || '';
        if (text) {
            wx.setClipboardData({
                data: text,
                success: () => wx.showToast({ title: "已复制", icon: "success" }),
            });
        }
    },

    sendMessage() {
        const text = this.data.inputValue.trim();
        if (!text || this.data.isProcessing) return;

        const url = extractUrl(text);
        if (!url) {
            wx.showToast({ title: '请输入有效的链接', icon: 'none' });
            return;
        }

        this.addMessage({ type: 'user', content: text });
        this.setData({ inputValue: '', isProcessing: true });

        const procId = genId();
        this.addMessage({
            id: procId,
            type: 'bot',
            status: 'processing',
            content: '正在解析链接...',
            progress: 5,
        });

        this.processVideo(url, procId);
    },

    async processVideo(url, procId) {
        const apiConfig = getApiConfig();
        try {
            // 第 1 步：解析视频页面
            this.updateMessage(procId, { content: '正在解析视频...', progress: 10 });
            const parseRes = await this.callCloud('parseVideo', { url });
            if (!parseRes.success) throw new Error(parseRes.error);

            const info = parseRes.info;
            let publicUrl;
            let cloudFileID = null;

            if (parseRes.needClientDownload) {
                publicUrl = await this.handleBilibili(parseRes, procId);
            } else {
                const videoUrl = parseRes.videoUrl;
                if (!videoUrl) throw new Error('未获取到视频地址');
                this.updateMessage(procId, { content: '正在下载视频...', progress: 20 });
                const uploadRes = await this.callCloud('downloadAndUpload', { videoUrl, extraHeaders: parseRes.biliHeaders });
                if (!uploadRes.success) throw new Error(uploadRes.error);
                publicUrl = uploadRes.publicUrl;
                cloudFileID = uploadRes.fileID || null;
            }

            if (!publicUrl) throw new Error('未获取到云存储链接');

            // 第 3 步：创建 ASR 任务
            this.updateMessage(procId, { content: '正在创建转录任务...', progress: 35 });
            const asrRes = await this.callCloud('startASR', { audioUrl: publicUrl });
            if (!asrRes.success) throw new Error(asrRes.error);
            const asrTaskId = asrRes.asrTaskId;

            // 第 4 步：轮询 ASR 结果
            const transcript = await this.pollASR(asrTaskId, procId);

            // ASR 完成后清理云存储中的视频文件
            if (cloudFileID) {
                this.callCloud('deleteCloudFile', { fileID: cloudFileID }).catch(() => {});
            }

            // 第 5 步：生成笔记
            this.updateMessage(procId, { content: '正在生成笔记...', progress: 80 });
            const noteRes = await this.callCloud('generateAndSave', {
                transcript, info, url,
                apiConfig: {
                    format: apiConfig.format || 'openai',
                    baseUrl: apiConfig.baseUrl,
                    apiKey: apiConfig.apiKey,
                    model: apiConfig.model,
                },
            });
            if (!noteRes.success) throw new Error(noteRes.error);

            // 第 6 步：保存笔记
            this.updateMessage(procId, { content: '正在保存...', progress: 90 });
            const saveRes = await this.callCloud('saveNote', { info, noteContent: noteRes.noteContent, url, category: '' });
            if (!saveRes.success) throw new Error(saveRes.error);

            const noteId = saveRes.noteId;
            const noteContent = noteRes.noteContent || '';
            const parsed = this.parseNoteContent(noteContent);

            this.updateMessage(procId, {
                status: 'done',
                progress: 100,
                result: {
                    title: info.title,
                    author: info.author,
                    platform: info.platform,
                    key_points: parsed.key_points,
                    keyPointsText: parsed.key_points.join('\n'),
                    quotes: parsed.quotes,
                    quotesText: parsed.quotes.join('\n'),
                    noteId,
                },
            });
        } catch (err) {
            console.error('处理失败:', err);
            const msg = this.getErrorMessage(err);
            this.updateMessage(procId, { status: 'error', content: msg });
        } finally {
            this.setData({ isProcessing: false });
        }
    },

    async handleBilibili(parseRes, procId) {
        const apiInfo = parseRes.biliApiInfo;
        const downloadUrls = parseRes.downloadUrls;

        if (apiInfo) {
            this.updateMessage(procId, { content: '正在获取音频地址...', progress: 15 });
            const audioUrl = await this.getBiliAudioFromPage(apiInfo.bvid);
            if (audioUrl) {
                this.updateMessage(procId, { content: '正在下载音频...', progress: 20 });
                const filePath = await this.clientDownload({ url: audioUrl, headers: {} });
                if (filePath) {
                    this.updateMessage(procId, { content: '正在上传到云存储...', progress: 30 });
                    return this.clientUpload(filePath);
                }
            }
        }

        if (downloadUrls && downloadUrls.length > 0) {
            console.log('降级：尝试云函数提供的 CDN URL');
            this.updateMessage(procId, { content: '正在下载音频（备用线路）...', progress: 20 });
            const filePath = await this.tryDownloadMultiple(downloadUrls, 3);
            if (filePath) {
                this.updateMessage(procId, { content: '正在上传到云存储...', progress: 30 });
                return this.clientUpload(filePath);
            }
        }
        return null;
    },

    async callCloud(action, data) {
        try {
            const res = await wx.cloud.callFunction({
                name: 'processVideo',
                data: { action, ...data },
            });
            return res.result || { success: false, error: '云函数返回为空' };
        } catch (e) {
            console.error('云函数调用失败:', action, e);
            if (e.errCode === -505004) return { success: false, error: '服务器内存不足，请稍后重试' };
            if (e.errCode === -501000 || e.message?.includes('timeout')) return { success: false, error: '服务器响应超时，请稍后重试' };
            return { success: false, error: e.message || '网络请求失败' };
        }
    },

    getErrorMessage(err) {
        const msg = err.message || err.errMsg || String(err);
        if (msg.includes('超时') || msg.includes('timeout')) return '处理超时，请稍后重试';
        if (msg.includes('内存') || msg.includes('memory')) return '服务器繁忙，请稍后重试';
        if (msg.includes('网络') || msg.includes('network')) return '网络错误，请检查网络后重试';
        if (msg.includes('API Key') || msg.includes('未配置')) return '请先在设置页面配置 API';
        return msg;
    },

    pollASR(taskId, procId) {
        return new Promise((resolve, reject) => {
            let attempts = 0;
            const maxAttempts = 120;
            let progress = 35;

            const poll = async () => {
                attempts++;
                if (attempts > maxAttempts) {
                    reject(new Error('语音转录超时（约6分钟）'));
                    return;
                }
                try {
                    const result = await this.callCloud('checkASR', { taskId });
                    if (result.status === 'done' && result.transcript) {
                        resolve(result.transcript);
                        return;
                    }
                    if (result.status === 'failed') {
                        reject(new Error(result.error || '语音转录失败'));
                        return;
                    }
                    if (!result.success && result.error) {
                        reject(new Error(result.error));
                        return;
                    }
                    progress = Math.min(progress + 0.5, 70);
                    this.updateMessage(procId, {
                        content: '正在转录语音... (' + Math.floor(attempts * 3) + '秒)',
                        progress,
                    });
                    setTimeout(poll, 3000);
                } catch (err) {
                    if (attempts % 5 === 0) console.warn('轮询异常，继续重试:', err);
                    setTimeout(poll, 3000);
                }
            };
            setTimeout(poll, 3000);
        });
    },

    getBiliAudioFromPage(bvid) {
        return new Promise((resolve) => {
            wx.downloadFile({
                url: `https://www.bilibili.com/video/${bvid}`,
                header: { "Referer": "https://www.bilibili.com/" },
                timeout: 30000,
                success: (res) => {
                    if (res.statusCode !== 200) { resolve(null); return; }
                    try {
                        const fs = wx.getFileSystemManager();
                        const html = fs.readFileSync(res.tempFilePath, 'utf8');
                        const match = html.match(/window\.__playinfo__\s*=\s*({.+?})\s*<\/script>/);
                        if (!match) { resolve(null); return; }
                        const playinfo = JSON.parse(match[1]);
                        const audioStream = playinfo.data?.dash?.audio?.[0];
                        resolve(audioStream?.baseUrl || audioStream?.base_url || null);
                    } catch (e) {
                        resolve(null);
                    }
                },
                fail: () => resolve(null),
            });
        });
    },

    tryDownloadMultiple(urls, maxTries) {
        const headers = { "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15", "Referer": "https://www.bilibili.com/" };
        const tryOne = (index) => {
            if (index >= Math.min(urls.length, maxTries)) return Promise.reject(new Error('All failed'));
            return this.clientDownload({ url: urls[index], headers }).catch(() => tryOne(index + 1));
        };
        return tryOne(0);
    },

    clientDownload(downloadInfo) {
        return new Promise((resolve, reject) => {
            wx.downloadFile({
                url: downloadInfo.url,
                header: downloadInfo.headers || {},
                timeout: 120000,
                success: (res) => {
                    res.statusCode === 200 ? resolve(res.tempFilePath) : reject(new Error('下载失败: HTTP ' + res.statusCode));
                },
                fail: (err) => reject(new Error('下载失败: ' + (err.errMsg || ''))),
            });
        });
    },

    clientUpload(filePath) {
        const cloudPath = 'videos/' + Date.now() + '_' + Math.random().toString(36).slice(2, 6) + '.m4s';
        return new Promise((resolve, reject) => {
            wx.cloud.uploadFile({
                cloudPath,
                filePath,
                success: (res) => {
                    wx.cloud.getTempFileURL({
                        fileList: [res.fileID],
                        success: (urlRes) => resolve(urlRes.fileList[0].tempFileURL),
                        fail: (err) => reject(err),
                    });
                },
                fail: (err) => reject(new Error('上传失败: ' + (err.errMsg || ''))),
            });
        });
    },

    parseNoteContent(md) {
        const key_points = [];
        const quotes = [];
        if (!md) return { key_points, quotes };

        try {
            const pointsMatch = md.match(/## 核心要点\n([\s\S]*?)(?=\n## |$)/);
            if (pointsMatch) {
                for (const line of pointsMatch[1].split('\n')) {
                    const m = line.match(/^\d+\.\s*\*\*(.+?)\*\*[：:](.*)/);
                    if (m) { key_points.push(m[1] + '：' + m[2].trim()); continue; }
                    const m2 = line.match(/^\d+\.\s*(.+)/);
                    if (m2) key_points.push(m2[1].trim());
                }
            }
            const quotesMatch = md.match(/## 金句摘录\n([\s\S]*?)(?=\n## |---|\n\*|$)/);
            if (quotesMatch) {
                for (const line of quotesMatch[1].split('\n')) {
                    const m = line.match(/^>\s*[""](.+?)[""]/);
                    if (m) quotes.push(m[1]);
                    const m2 = line.match(/^-\s*[""](.+?)[""]/);
                    if (m2) quotes.push(m2[1]);
                }
            }
        } catch (e) { /* ignore */ }
        return { key_points, quotes };
    },

    addMessage(msg) {
        const messages = this.data.messages.concat([{
            id: msg.id || genId(),
            type: msg.type,
            content: msg.content || '',
            status: msg.status || '',
            progress: msg.progress || 0,
            result: msg.result || null,
        }]);
        this.setData({ messages });
        this.scrollToBottom();
    },

    updateMessage(msgId, updates) {
        const messages = this.data.messages.map(m => {
            if (m.id === msgId) return Object.assign({}, m, updates);
            return m;
        });
        this.setData({ messages });
        this.scrollToBottom();
    },

    scrollToBottom() {
        setTimeout(() => this.setData({ scrollToId: 'bottom' }), 100);
    },

    viewDetail(e) {
        const msgId = e.currentTarget.dataset.id;
        const msg = this.data.messages.find(m => m.id === msgId);
        const id = msg?.result?.noteId;
        if (id) wx.navigateTo({ url: '/pages/detail/detail?id=' + id });
        else wx.showToast({ title: '笔记不存在', icon: 'none' });
    },
});
