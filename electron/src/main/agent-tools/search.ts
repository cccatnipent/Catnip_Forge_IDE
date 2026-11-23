import { objectSchema, stringSchema, type AgentTool } from './types';

export function platformSearchTool(): AgentTool {
  const templates: Record<string, string> = {
    bilibili: 'https://search.bilibili.com/all?keyword=', baidu: 'https://www.baidu.com/s?wd=',
    google: 'https://www.google.com/search?q=', youtube: 'https://www.youtube.com/results?search_query=',
    taobao: 'https://s.taobao.com/search?q=', tmall: 'https://list.tmall.com/search_product.htm?q=',
    '1688': 'https://s.1688.com/selloffer/offer_search.htm?keywords=', douyin: 'https://www.douyin.com/search/',
  };
  return {
    definition: { name: 'PlatformSearchUrl', description: '生成指定平台的站内搜索 URL；不执行网络请求。下一步使用 browser_navigate 打开。', parameters: objectSchema({ platform: { type: 'string', enum: Object.keys(templates) }, query: stringSchema(1000) }, ['platform', 'query']) },
    profiles: ['default'], async execute(input) { return { url: templates[String(input.platform)] + encodeURIComponent(String(input.query)) }; },
  };
}
