import { defineConfig } from 'vitepress'

export default defineConfig({
  lang: 'zh-CN',
  title: 'Lynkco-push 配置教程',
  description: 'Lynkco-push 配置教程',
  base: '/',
  cleanUrls: true,
  srcExclude: ['README.md'],
  themeConfig: {
    siteTitle: 'Lynkco-push 配置教程',
    nav: [
      { text: '教程首页', link: '/' },
      { text: '返回工具箱', link: 'https://ltools.asia/' }
    ],
    sidebar: [
      { text: 'Lynkco-push 配置教程', link: '/lynkco-plus' }
    ],
    outline: { label: '本页目录' },
    docFooter: { prev: '上一篇', next: '下一篇' },
    returnToTopLabel: '返回顶部',
    sidebarMenuLabel: '目录',
    darkModeSwitchLabel: '主题',
    lightModeSwitchTitle: '切换到浅色模式',
    darkModeSwitchTitle: '切换到深色模式',
    notFound: {
      title: '页面未找到',
      quote: '这个地址不存在，返回教程首页继续查找。',
      linkLabel: '返回教程首页',
      linkText: '返回教程首页'
    }
  }
})
