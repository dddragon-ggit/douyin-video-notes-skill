const db = wx.cloud.database();
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

            const notesRes = await db.collection("notes")
                .orderBy("created_at", "desc")
                .limit(100)
                .get();

            const allNotes = notesRes.data || [];
            const uncategorizedNotes = [];

            for (const note of allNotes) {
                if (note.category && categoryNotes[note.category] !== undefined) {
                    categoryNotes[note.category].push(note);
                } else if (note.category) {
                    uncategorizedNotes.push(note);
                } else {
                    uncategorizedNotes.push(note);
                }
            }

            this.setData({
                categories: cats,
                categoryNotes,
                uncategorizedNotes,
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
});
