const STORAGE_KEY = "apiConfig";

Page({
    data: {
        format: "openai",
        baseUrl: "",
        apiKey: "",
        model: "",
        tencentId: "",
        tencentKey: "",
        editingKey: false,
        editingTencentKey: false,
    },

    onLoad() {
        this.loadConfig();
    },

    onShow() {
        this.loadConfig();
    },

    loadConfig() {
        const cfg = wx.getStorageSync(STORAGE_KEY) || {};
        this.setData({
            format: cfg.format || "openai",
            baseUrl: cfg.baseUrl || "",
            apiKey: cfg.apiKey || "",
            model: cfg.model || "",
            tencentId: cfg.tencentId || "",
            tencentKey: cfg.tencentKey || "",
        });
    },

    saveConfig() {
        const cfg = {
            format: this.data.format,
            baseUrl: this.data.baseUrl.trim(),
            apiKey: this.data.apiKey.trim(),
            model: this.data.model.trim(),
            tencentId: this.data.tencentId.trim(),
            tencentKey: this.data.tencentKey.trim(),
        };

        if (!cfg.baseUrl) { wx.showToast({ title: "请输入 API 地址", icon: "none" }); return; }
        if (!cfg.apiKey) { wx.showToast({ title: "请输入 API Key", icon: "none" }); return; }

        wx.setStorageSync(STORAGE_KEY, cfg);
        wx.showToast({ title: "已保存", icon: "success" });
    },

    onFormatChange(e) {
        this.setData({ format: e.detail.value });
    },

    onBaseUrlInput(e) { this.setData({ baseUrl: e.detail.value }); },
    onApiKeyInput(e) { this.setData({ apiKey: e.detail.value }); },
    onModelInput(e) { this.setData({ model: e.detail.value }); },
    onTencentIdInput(e) { this.setData({ tencentId: e.detail.value }); },
    onTencentKeyInput(e) { this.setData({ tencentKey: e.detail.value }); },

    toggleKey() { this.setData({ editingKey: !this.data.editingKey }); },
    toggleTencentKey() { this.setData({ editingTencentKey: !this.data.editingTencentKey }); },

    clearConfig() {
        wx.showModal({
            title: "清除配置",
            content: "确定清除所有 API 配置吗？",
            success: (res) => {
                if (res.confirm) {
                    wx.removeStorageSync(STORAGE_KEY);
                    this.setData({
                        format: "openai", baseUrl: "", apiKey: "", model: "",
                        tencentId: "", tencentKey: "",
                    });
                    wx.showToast({ title: "已清除", icon: "success" });
                }
            },
        });
    },
});
