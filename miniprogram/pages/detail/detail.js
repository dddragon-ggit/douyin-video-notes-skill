const db = wx.cloud.database();

Page({
    data: {
        note: null,
        loading: true,
        htmlContent: '',
        category: '',
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
                this.setData({
                    note,
                    category: note.category || '',
                    htmlContent: this.markdownToHtml(note.detail_markdown || ''),
                    loading: false,
                });
            })
            .catch(err => {
                console.error("加载笔记失败:", err);
                this.setData({ loading: false });
                wx.showToast({ title: "加载失败", icon: "none" });
            });
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
            } else {
                wx.showToast({ title: "保存失败", icon: "none" });
            }
        }).catch(() => {
            wx.showToast({ title: "保存失败", icon: "none" });
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
