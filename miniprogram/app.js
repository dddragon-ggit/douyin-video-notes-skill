App({
    onLaunch() {
        if (!wx.cloud) {
            console.error('请使用 2.2.3 或以上的基础库以使用云能力');
            return;
        }
        wx.cloud.init({
            env: 'cloudbase-d8g00w8kf690bda18',
            traceUser: true,
        });
    },

    globalData: {
        // 默认设置
        settings: {
            apiProvider: 'openai',  // openai | anthropic
            asrProvider: 'tencent', // tencent | openai
        }
    }
});
