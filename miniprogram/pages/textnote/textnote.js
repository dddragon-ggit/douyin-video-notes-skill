const db = wx.cloud.database();

function getApiConfig() {
    try {
        return wx.getStorageSync('apiConfig') || {};
    } catch (e) {
        return {};
    }
}

Page({
    data: {
        title: '',
        text: '',
        generating: false,
        result: null,
        noteId: '',
    },

    onTitleInput(e) {
        this.setData({ title: e.detail.value });
    },

    onTextInput(e) {
        this.setData({ text: e.detail.value });
    },

    // 清空输入
    clearInput() {
        this.setData({ text: '', result: null, noteId: '' });
    },

    // 粘贴剪贴板
    pasteClipboard() {
        wx.getClipboardData({
            success: (res) => {
                if (res.data) {
                    this.setData({ text: res.data });
                    wx.showToast({ title: "已粘贴", icon: "success" });
                }
            },
        });
    },

    // 生成笔记
    async generate() {
        const text = this.data.text.trim();
        if (text.length < 10) {
            wx.showToast({ title: "内容太短，至少 10 个字", icon: "none" });
            return;
        }

        const apiConfig = getApiConfig();
        this.setData({ generating: true, result: null, noteId: '' });

        try {
            // 调用云函数生成笔记
            const genRes = await wx.cloud.callFunction({
                name: 'processVideo',
                data: {
                    action: 'generateFromText',
                    text,
                    title: this.data.title.trim() || '文本笔记',
                    apiConfig: {
                        format: apiConfig.format || 'openai',
                        baseUrl: apiConfig.baseUrl,
                        apiKey: apiConfig.apiKey,
                        model: apiConfig.model,
                    },
                },
            });

            if (!genRes.result || !genRes.result.success) {
                throw new Error(genRes.result?.error || '生成失败');
            }

            const noteContent = genRes.result.noteContent;
            const parsed = this.parseNoteContent(noteContent);

            // 保存笔记
            const saveRes = await wx.cloud.callFunction({
                name: 'processVideo',
                data: {
                    action: 'saveNote',
                    info: {
                        title: this.data.title.trim() || '文本笔记',
                        author: '用户输入',
                        platform: '文本笔记',
                        duration: 0,
                    },
                    noteContent,
                    url: '',
                    category: '',
                },
            });

            const noteId = saveRes.result?.noteId || '';

            this.setData({
                generating: false,
                result: {
                    title: this.data.title.trim() || '文本笔记',
                    platform: '文本笔记',
                    key_points: parsed.key_points,
                    keyPointsText: parsed.keyPointsText,
                    quotes: parsed.quotes,
                    quotesText: parsed.quotesText,
                },
                noteId,
            });

            wx.showToast({ title: "生成完成", icon: "success" });
        } catch (e) {
            this.setData({ generating: false });
            wx.showToast({ title: e.message || "生成失败", icon: "none" });
        }
    },

    // 解析笔记内容（复用 chat 页逻辑）
    parseNoteContent(md) {
        const key_points = [];
        const quotes = [];

        const kpMatch = md.match(/## 核心要点([\s\S]*?)(?=\n## |$)/);
        if (kpMatch) {
            const lines = kpMatch[1].split('\n');
            for (const line of lines) {
                const m = line.match(/^\d+\.\s*\*\*(.+?)\*\*[:：]\s*(.+)/);
                if (m) {
                    key_points.push({ title: m[1], desc: m[2].trim() });
                } else {
                    const m2 = line.match(/^\d+\.\s*(.+)/);
                    if (m2) key_points.push({ title: m2[1].trim(), desc: '' });
                }
            }
        }

        const qMatch = md.match(/## 金句摘录([\s\S]*?)(?=\n## |$)/);
        if (qMatch) {
            const lines = qMatch[1].split('\n');
            for (const line of lines) {
                const m = line.match(/^[->]\s*[""「](.+?)[""」]/);
                if (m) quotes.push(m[1].trim());
                else {
                    const m2 = line.match(/^[->]\s*(.+)/);
                    if (m2 && m2[1].trim().length > 4) quotes.push(m2[1].trim());
                }
            }
        }

        return {
            key_points,
            keyPointsText: key_points.map(p => p.title + (p.desc ? '：' + p.desc : '')).join('\n'),
            quotes,
            quotesText: quotes.map(q => '"' + q + '"').join('\n'),
        };
    },

    // 查看完整笔记
    viewDetail() {
        if (this.data.noteId) {
            wx.navigateTo({ url: '/pages/detail/detail?id=' + this.data.noteId });
        }
    },

    // 复制笔记内容
    copyResult() {
        if (!this.data.result) return;
        let text = this.data.result.keyPointsText;
        if (this.data.result.quotesText) text += '\n\n' + this.data.result.quotesText;
        wx.setClipboardData({
            data: text,
            success: () => wx.showToast({ title: "已复制", icon: "success" }),
        });
    },
});
