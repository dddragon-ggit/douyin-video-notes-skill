const CATS_KEY = "categories_v2";

function loadCategoriesLocal() {
    try {
        return wx.getStorageSync(CATS_KEY) || [];
    } catch (e) {
        return [];
    }
}

function saveCategoriesLocal(list) {
    wx.setStorageSync(CATS_KEY, list);
}

// 星标优先 + 时间倒序排列
function sortNotes(notes) {
    return notes.slice().sort((a, b) => {
        // 星标优先
        const sa = a.starred ? 1 : 0;
        const sb = b.starred ? 1 : 0;
        if (sa !== sb) return sb - sa;
        // 未读优先（read 为 false 或 undefined 的排前面）
        const ra = a.read ? 1 : 0;
        const rb = b.read ? 1 : 0;
        if (ra !== rb) return ra - rb;
        return 0; // 保持原有 created_at 倒序
    });
}

// 从 detail_markdown 中提取便签摘要
function getMemoSummary(note) {
    if (note.memo) return note.memo.slice(0, 30) + (note.memo.length > 30 ? '...' : '');
    // 兼容旧数据：从 detail_markdown 提取
    const md = note.detail_markdown || '';
    const match = md.match(/^📝\s*(.+)/m);
    if (match) return match[1].trim().slice(0, 30);
    return '';
}

Page({
    data: {
        uncategorizedNotes: [],
        categories: [],
        categoryNotes: {},
        collapsedGroups: {},
        loading: true,
    },

    onShow() {
        this.loadAll();
    },

    async loadAll() {
        this.setData({ loading: true });
        try {
            const cats = loadCategoriesLocal();
            const categoryNotes = {};
            for (const c of cats) {
                categoryNotes[c.name] = [];
            }

            const notesRes = await wx.cloud.callFunction({
                name: 'processVideo',
                data: { action: 'listNotes' },
            });

            const result = notesRes.result || {};
            if (!result.success) {
                throw new Error(result.error || "加载历史笔记失败");
            }

            const allNotes = result.notes || [];
            const uncategorizedNotes = [];

            for (const note of allNotes) {
                note._memoSummary = getMemoSummary(note);
                if (note.category && categoryNotes[note.category] !== undefined) {
                    categoryNotes[note.category].push(note);
                } else {
                    uncategorizedNotes.push(note);
                }
            }

            // 每组内星标优先排序
            for (const name of Object.keys(categoryNotes)) {
                categoryNotes[name] = sortNotes(categoryNotes[name]);
            }
            const sortedUncategorized = sortNotes(uncategorizedNotes);

            this.setData({
                categories: cats,
                categoryNotes,
                uncategorizedNotes: sortedUncategorized,
                loading: false,
            });
        } catch (err) {
            console.error("加载失败:", err);
            this.setData({ loading: false });
            wx.showToast({ title: "加载失败", icon: "none" });
        }
    },

    toggleGroup(e) {
        const name = e.currentTarget.dataset.name;
        const collapsed = Object.assign({}, this.data.collapsedGroups);
        collapsed[name] = !collapsed[name];
        this.setData({ collapsedGroups: collapsed });
    },

    createCategory() {
        const cats = this.data.categories;
        wx.showModal({
            title: "新建分类",
            editable: true,
            placeholderText: "输入分类名称",
            success: (res) => {
                if (!res.confirm || !res.content) return;
                const name = res.content.trim();
                if (!name) return;
                if (cats.find(c => c.name === name)) {
                    wx.showToast({ title: "分类名已存在", icon: "none" });
                    return;
                }
                cats.push({ name, _id: 'cat_' + Date.now() });
                saveCategoriesLocal(cats);
                const categoryNotes = Object.assign({}, this.data.categoryNotes);
                categoryNotes[name] = [];
                this.setData({ categories: cats, categoryNotes });
                wx.showToast({ title: "已创建", icon: "success" });
            },
        });
    },

    renameCategory(e) {
        const cat = e.currentTarget.dataset.cat;
        wx.showModal({
            title: "重命名",
            editable: true,
            placeholderText: "新名称",
            content: cat.name,
            success: async (res) => {
                if (!res.confirm || !res.content) return;
                const newName = res.content.trim();
                if (!newName || newName === cat.name) return;

                const cats = this.data.categories;
                if (cats.find(c => c.name === newName)) {
                    wx.showToast({ title: "名称已存在", icon: "none" });
                    return;
                }

                wx.showLoading({ title: "重命名中..." });
                try {
                    // 通过云函数更新数据库中的分类名
                    await wx.cloud.callFunction({
                        name: 'processVideo',
                        data: { action: 'renameCategoryNotes', oldName: cat.name, newName },
                    });

                    const idx = cats.findIndex(c => c.name === cat.name);
                    if (idx >= 0) cats[idx].name = newName;
                    saveCategoriesLocal(cats);

                    wx.hideLoading();
                    wx.showToast({ title: "已重命名", icon: "success" });
                    this.loadAll();
                } catch (e) {
                    wx.hideLoading();
                    wx.showToast({ title: "重命名失败", icon: "none" });
                }
            },
        });
    },

    deleteCategory(e) {
        const cat = e.currentTarget.dataset.cat;
        wx.showModal({
            title: "删除",
            content: `确定删除"${cat.name}"？笔记将回到未分类。`,
            success: async (res) => {
                if (!res.confirm) return;

                wx.showLoading({ title: "删除中..." });
                try {
                    // 通过云函数清空数据库中的分类
                    await wx.cloud.callFunction({
                        name: 'processVideo',
                        data: { action: 'clearCategoryNotes', oldCategory: cat.name },
                    });

                    const cats = this.data.categories.filter(c => c.name !== cat.name);
                    saveCategoriesLocal(cats);

                    wx.hideLoading();
                    wx.showToast({ title: "已删除", icon: "success" });
                    this.loadAll();
                } catch (e) {
                    wx.hideLoading();
                    wx.showToast({ title: "删除失败", icon: "none" });
                }
            },
        });
    },

    moveNote(e) {
        const noteId = e.currentTarget.dataset.id;
        const cats = this.data.categories;
        if (cats.length === 0) {
            wx.showToast({ title: "请先创建分类", icon: "none" });
            return;
        }
        const itemList = cats.map(c => c.name);
        itemList.unshift("移至未分类");

        wx.showActionSheet({
            itemList,
            success: async (res) => {
                const newCat = res.tapIndex > 0 ? itemList[res.tapIndex] : "";
                wx.showLoading({ title: "移动中..." });
                try {
                    // 通过云函数更新笔记分类
                    const result = await wx.cloud.callFunction({
                        name: 'processVideo',
                        data: { action: 'updateNoteCategory', noteId, category: newCat },
                    });
                    wx.hideLoading();
                    if (result.result && result.result.success) {
                        wx.showToast({ title: newCat ? "已移至 " + newCat : "已移至未分类", icon: "success" });
                        this.loadAll();
                    } else {
                        wx.showToast({ title: "移动失败: " + (result.result?.error || "未知错误"), icon: "none" });
                    }
                } catch (e) {
                    wx.hideLoading();
                    console.error("移动笔记失败:", e);
                    wx.showToast({ title: "移动失败", icon: "none" });
                }
            },
        });
    },

    viewDetail(e) {
        const id = e.currentTarget.dataset.id;
        wx.navigateTo({ url: "/pages/detail/detail?id=" + id });
    },

    // 切换星标（阻止冒泡，不触发 viewDetail）
    toggleStar(e) {
        const noteId = e.currentTarget.dataset.id;
        const starred = e.currentTarget.dataset.starred;
        const newStarred = !starred;

        // 乐观更新 UI
        this.updateNoteLocal(noteId, { starred: newStarred });

        wx.cloud.callFunction({
            name: 'processVideo',
            data: { action: 'updateNoteStar', noteId, starred: newStarred },
        }).catch(() => {
            this.updateNoteLocal(noteId, { starred: starred });
            wx.showToast({ title: "操作失败", icon: "none" });
        });
    },

    // 切换已读（阻止冒泡，不触发 viewDetail）
    toggleRead(e) {
        const noteId = e.currentTarget.dataset.id;
        const read = e.currentTarget.dataset.read;
        const newRead = !read;

        this.updateNoteLocal(noteId, { read: newRead });

        wx.cloud.callFunction({
            name: 'processVideo',
            data: { action: 'updateNoteRead', noteId, read: newRead },
        }).catch(() => {
            this.updateNoteLocal(noteId, { read: read });
            wx.showToast({ title: "操作失败", icon: "none" });
        });
    },

    // 本地更新笔记数据并重新排序
    updateNoteLocal(noteId, updates) {
        const updateList = (list) => list.map(n => n._id === noteId ? Object.assign({}, n, updates) : n);
        const uncategorizedNotes = sortNotes(updateList(this.data.uncategorizedNotes));
        const categoryNotes = {};
        for (const [name, notes] of Object.entries(this.data.categoryNotes)) {
            categoryNotes[name] = sortNotes(updateList(notes));
        }
        this.setData({ uncategorizedNotes, categoryNotes });
    },
});
