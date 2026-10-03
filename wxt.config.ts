import { defineConfig } from 'wxt';

export default defineConfig({
  // 桌面 Chrome，Manifest V3 是 WXT 的默认目标。
  manifest: {
    name: 'Peak Distance',
    minimum_chrome_version: '142',
    description: '网页 / X 与 YouTube 英语学习扩展',
    permissions: ['storage', 'sidePanel'],
    host_permissions: ['https://api.deepseek.com/*', 'https://dict.youdao.com/*', 'https://dictionary.cambridge.org/*', 'https://translate.googleapis.com/*'],
    optional_host_permissions: ['https://*/*'],
    action: {
      default_title: '打开 Peak Distance',
    },
    icons: { 16:'brand/peak-icon.png',32:'brand/peak-icon.png',48:'brand/peak-icon.png',128:'brand/peak-icon.png' },
    web_accessible_resources: [{resources:['sidepanel.html','assets/*','chunks/*','brand/*'],matches:['https://*/*']}],
    // side_panel.default_path 由 entrypoints/sidepanel 自动生成。
  },
});
