const db = wx.cloud.database();

Page({
    data: {
        note: null,
        loading: true,
        htmlContent: '',
        category: '',
        starred: false,
        memo: '',
        videoUrl: '',
    },

    onLoad(options) {
        if (options.id) {
            this.loadNote(options.id);
        }
    },

    loadNote(id) {
        db.collection("notes").doc(id).get()
            .then(res => {
                const note = res.data;
                const raw = note.detail_markdown || '';
                const parsed = this.parsePrefix(raw);
                this.setData({
                    note,
                    category: note.category || '',
                    starred: note.starred || false,
                    memo: note.memo || '',
                    videoUrl: parsed.videoUrl,
                    htmlContent: this.markdownToHtml(parsed.content),
                    loading: false,
                });
            })
            .catch(err => {
                console.error("加载笔记失败:", err);
                this.setData({ loading: false });
                wx.showToast({ title: "加载失败", icon: "none" });
            });
    },

    // 解析 detail_markdown 开头的链接和便签，返回原始笔记内容
    parsePrefix(md) {
        let videoUrl = '';
        let content = md;

        // 提取 🔗 链接
        const linkMatch = content.match(/^🔗\s*\[视频链接\]\((https?:\/\/[^\)]+)\)/);
        if (linkMatch) videoUrl = linkMatch[1];

        // 剥离前缀行
        content = content.replace(/^🔗\s*\[视频链接\]\(https?:\/\/[^\)]+\)\n*/g, '');
        content = content.replace(/^📝\s*.+\n*/gm, '');

        return { videoUrl, content: content.trimStart() };
    },

    markdownToHtml(md) {
        if (!md) return '';
        let html = md
            .replace(/^### (.+)$/gm, '<h3>$1</h3>')
            .replace(/^## (.+)$/gm, '<h2>$1</h2>')
            .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
            .replace(/\*(.+?)\*/g, '<em>$1</em>')
            .replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>')
            .replace(/^- (.+)$/gm, '<li>$1</li>')
            .replace(/^\d+\. (.+)$/gm, '<li>$1</li>')
            .replace(/\n\n/g, '</p><p>')
            .replace(/\n/g, '<br>');
        return '<p>' + html + '</p>';
    },

    // 星标切换
    toggleStar() {
        const newStarred = !this.data.starred;
        this.setData({ starred: newStarred });
        wx.cloud.callFunction({
            name: 'processVideo',
            data: { action: 'updateNoteStar', noteId: this.data.note._id, starred: newStarred },
        }).catch(() => {
            this.setData({ starred: !newStarred });
            wx.showToast({ title: "操作失败", icon: "none" });
        });
    },

    // 复制视频链接
    copyLink() {
        if (!this.data.videoUrl) return;
        wx.setClipboardData({
            data: this.data.videoUrl,
            success: () => wx.showToast({ title: "链接已复制", icon: "success" }),
        });
    },

    // 便签输入
    onMemoInput(e) {
        this.setData({ memo: e.detail.value });
    },

    saveMemo() {
        if (!this.data.note) return;
        wx.cloud.callFunction({
            name: 'processVideo',
            data: { action: 'updateNoteMemo', noteId: this.data.note._id, memo: this.data.memo },
        }).then((res) => {
            if (res.result && res.result.success) {
                wx.showToast({ title: "便签已保存", icon: "success" });
                // 重新加载以更新 markdown 显示
                this.loadNote(this.data.note._id);
            }
        }).catch(() => {
            wx.showToast({ title: "保存失败", icon: "none" });
        });
    },

    // 分类
    onCategoryInput(e) {
        this.setData({ category: e.detail.value });
    },

    saveCategory() {
        if (!this.data.note) return;
        wx.cloud.callFunction({
            name: 'processVideo',
            data: {
                action: 'updateNoteCategory',
                noteId: this.data.note._id,
                category: this.data.category,
            },
        }).then((res) => {
            if (res.result && res.result.success) {
                wx.showToast({ title: "分类已保存", icon: "success" });
            }
        }).catch(() => {
            wx.showToast({ title: "保存失败", icon: "none" });
        });
    },

    // 重新生成笔记
    regenerate() {
        const url = this.data.videoUrl;
        if (!url) {
            wx.showToast({ title: "笔记中无视频链接，无法重新生成", icon: "none" });
            return;
        }
        wx.showModal({
            title: "重新生成",
            content: "将基于原视频重新生成笔记，确认？",
            success: (res) => {
                if (res.confirm) {
                    wx.navigateTo({ url: '/pages/chat/chat?url=' + encodeURIComponent(url) });
                }
            },
        });
    },

    // 删除笔记
    deleteNote() {
        wx.showModal({
            title: "删除笔记",
            content: "确定删除此笔记？删除后无法恢复。",
            confirmColor: "#e74c3c",
            success: (res) => {
                if (!res.confirm) return;
                wx.showLoading({ title: "删除中..." });
                wx.cloud.callFunction({
                    name: 'processVideo',
                    data: { action: 'deleteNote', noteId: this.data.note._id },
                }).then((r) => {
                    wx.hideLoading();
                    if (r.result && r.result.success) {
                        wx.showToast({ title: "已删除", icon: "success" });
                        setTimeout(() => wx.navigateBack(), 500);
                    } else {
                        wx.showToast({ title: "删除失败", icon: "none" });
                    }
                }).catch(() => {
                    wx.hideLoading();
                    wx.showToast({ title: "删除失败", icon: "none" });
                });
            },
        });
    },

    copyContent() {
        if (!this.data.note) return;
        wx.setClipboardData({
            data: this.data.note.detail_markdown || '',
            success: () => wx.showToast({ title: "已复制", icon: "success" }),
        });
    },

    onShareAppMessage() {
        const note = this.data.note;
        return {
            title: note ? note.title : "视频笔记",
            path: "/pages/detail/detail?id=" + (note ? note._id : ""),
        };
    },
});
