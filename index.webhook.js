// Webhook version of the bot (keeps index.js unchanged). Suitable for free hosts like Render/Cloud Run.
// Run: node index.webhook.js

import 'dotenv/config'
import http from 'http'
import { Telegraf } from 'telegraf'
import { ethers } from 'ethers'

const {
  TG_BOT_TOKEN,
  TRADER_PRIVATE_KEY,
  WEBHOOK_URL, // e.g. https://your-service.onrender.com
  PORT = 3000
} = process.env

if (!TG_BOT_TOKEN || !TRADER_PRIVATE_KEY) {
  console.error('Missing TG_BOT_TOKEN or TRADER_PRIVATE_KEY in .env')
  process.exit(1)
}

// Chain config (same as index.js)
const X_LAYER_RPC = 'https://rpc.xlayer.tech'
const WOKB_ADDR = '0xe538905cf8410324e03a5a23c1c177a474d59b2b'
const PUMPU_FACTORY = '0xC4cEBDf3D4bBF14812DcCB1ccB20AB26EA547f44'

const provider = new ethers.JsonRpcProvider(X_LAYER_RPC)
const wallet = new ethers.Wallet(TRADER_PRIVATE_KEY, provider)

// ABIs
const ERC20_ABI = [
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)'
]
const PUMPU_FACTORY_ABI = [ 'event Deployed(address indexed addr, uint256 amount)' ]
const PUMPTOKEN_META_ABI = [
  'function description() view returns (string)',
  'function website() view returns (string)',
  'function telegram() view returns (string)',
  'function twitter() view returns (string)'
]
const PUMPU_IFACE = new ethers.Interface(PUMPU_FACTORY_ABI)

// Bot
const bot = new Telegraf(TG_BOT_TOKEN)
let BOT_USERNAME = ''
await bot.telegram.getMe().then((me) => { BOT_USERNAME = me.username }).catch(() => {})

// State
const subscribedUsers = new Set()
const userPushPrefs = new Map() // userId -> { requireMediaLink: boolean, mcUsdThreshold: number|null, lang: 'en'|'zh' }

// 新增：市值提醒功能
const marketCapAlerts = new Map() // tokenAddr -> { lastPushed: timestamp, users: Set<userId> }
const MC_CHECK_INTERVAL = 5 * 60 * 1000 // 5分钟检查一次市值
let lastMcCheck = 0

function getPrefs(id) {
  if (!userPushPrefs.has(id)) userPushPrefs.set(id, { requireMediaLink: false, mcUsdThreshold: null, lang: 'en' })
  return userPushPrefs.get(id)
}
function setLang(id, lang) { getPrefs(id).lang = (lang === 'zh' ? 'zh' : 'en') }

// 新增：市值检查函数
async function checkMarketCapAlerts() {
  const now = Date.now()
  if (now - lastMcCheck < MC_CHECK_INTERVAL) return
  lastMcCheck = now
  
  console.log('🔍 检查市值提醒...')
  
  for (const [tokenAddr, alertData] of marketCapAlerts) {
    try {
      // 获取代币信息
      const token = new ethers.Contract(tokenAddr, ERC20_ABI, provider)
      const [totalSupply, decimals] = await Promise.all([
        token.totalSupply().catch(() => 0n),
        token.decimals().catch(() => 18)
      ])
      
      // 获取价格信息（通过池子）
      let priceInWOKB = null
      try {
        const PAIR_ABI = [
          'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
          'function token0() view returns (address)',
          'function token1() view returns (address)'
        ]
        const pair = new ethers.Contract(tokenAddr, PAIR_ABI, provider)
        const [reserve0, reserve1] = await pair.getReserves()
        const token0 = await pair.token0()
        const token1 = await pair.token1()
        
        if (token0.toLowerCase() === WOKB_ADDR.toLowerCase()) {
          if (reserve1 > 0n) {
            priceInWOKB = Number(ethers.formatEther(reserve0)) / Number(ethers.formatEther(reserve1))
          }
        } else if (token1.toLowerCase() === WOKB_ADDR.toLowerCase()) {
          if (reserve0 > 0n) {
            priceInWOKB = Number(ethers.formatEther(reserve1)) / Number(ethers.formatEther(reserve0))
          }
        }
      } catch (e) {
        console.log(`无法获取 ${tokenAddr} 价格:`, e.message)
        continue
      }
      
      if (!priceInWOKB) continue
      
      // 计算市值（假设 1 WOKB = $1，实际应该查询真实价格）
      const supplyFloat = Number(ethers.formatUnits(totalSupply, decimals))
      const marketCapUSD = supplyFloat * priceInWOKB
      
      console.log(`代币 ${tokenAddr} 当前市值: $${marketCapUSD.toFixed(2)}`)
      
      // 检查每个用户的阈值
      for (const userId of alertData.users) {
        try {
          const prefs = getPrefs(userId)
          if (prefs.mcUsdThreshold && marketCapUSD >= prefs.mcUsdThreshold) {
            // 发送市值提醒
            const lang = prefs.lang
            const symbol = await token.symbol().catch(() => 'Unknown')
            
            const alertText = lang === 'zh' 
              ? `🚨 <b>市值提醒</b>\n\n代币: ${symbol}\n合约: <code>${tokenAddr}</code>\n当前市值: <b>$${marketCapUSD.toFixed(2)}</b>\n您的阈值: <b>$${prefs.mcUsdThreshold}</b>\n\n💡 代币市值已达到您设定的提醒阈值！`
              : `🚨 <b>Market Cap Alert</b>\n\nToken: ${symbol}\nContract: <code>${tokenAddr}</code>\nCurrent MC: <b>$${marketCapUSD.toFixed(2)}</b>\nYour threshold: <b>$${prefs.mcUsdThreshold}</b>\n\n💡 Token market cap has reached your alert threshold!`
            
            await bot.telegram.sendMessage(userId, alertText, { parse_mode: 'HTML' })
            console.log(`已发送市值提醒给用户 ${userId}: ${symbol} 市值 $${marketCapUSD.toFixed(2)}`)
          }
        } catch (e) {
          console.log(`发送市值提醒给用户 ${userId} 失败:`, e.message)
        }
      }
      
    } catch (e) {
      console.log(`检查代币 ${tokenAddr} 市值失败:`, e.message)
    }
  }
}

// 新增：添加代币到市值提醒列表
function addToMarketCapAlerts(tokenAddr, userId) {
  if (!marketCapAlerts.has(tokenAddr)) {
    marketCapAlerts.set(tokenAddr, { lastPushed: Date.now(), users: new Set() })
  }
  marketCapAlerts.get(tokenAddr).users.add(userId)
  console.log(`用户 ${userId} 已订阅代币 ${tokenAddr} 的市值提醒`)
}

// 新增：移除代币的市值提醒
function removeFromMarketCapAlerts(tokenAddr, userId) {
  if (marketCapAlerts.has(tokenAddr)) {
    const alertData = marketCapAlerts.get(tokenAddr)
    alertData.users.delete(userId)
    if (alertData.users.size === 0) {
      marketCapAlerts.delete(tokenAddr)
      console.log(`代币 ${tokenAddr} 的市值提醒已完全移除`)
    }
  }
}

// UI helpers
function securityHeader(lang) {
  return lang === 'zh'
    ? '⚠️ 安全提醒：所有停止服务/提升返佣/切换机器人的广告都是诈骗！不要点击任何 Telegram 置顶广告❗️\n推特：https://x.com/ooxxkk_bot?s=21'
    : '⚠️ Security reminder: Ads about service stops / higher rebates / switching bots are scams! Do NOT click any pinned Telegram ads!❗️\nTwitter: https://x.com/ooxxkk_bot?s=21'
}

function showMenu(ctx) {
  const prefs = getPrefs(ctx.from.id)
  const title = prefs.lang === 'zh' ? '请选择功能：' : 'Please choose an action:'
  const invite = BOT_USERNAME ? `https://t.me/${BOT_USERNAME}?start=${ctx.from.id}` : ''
  const inviteLine = prefs.lang === 'zh' ? `邀请链接（仅本用户专属）：${invite}` : `Invite link (for you): ${invite}`
  const text = [securityHeader(prefs.lang), invite && inviteLine, '', title].filter(Boolean).join('\n')
  return ctx.reply(text, {
    reply_markup: {
      inline_keyboard: [
        [ { text: prefs.lang === 'zh' ? '🔍 分析' : '🔍 Analyze', callback_data: 'm_analyze' } ],
        [ { text: prefs.lang === 'zh' ? '🌐 切换语言' : '🌐 Language', callback_data: 'm_lang' } ],
        [ { text: prefs.lang === 'zh' ? '🛠️ 推送过滤设置' : '🛠️ Push Filter Settings', callback_data: 'm_filters' } ],
        [ { text: prefs.lang === 'zh' ? '🔔 监听状态' : '🔔 Watch Status', callback_data: 'm_status' } ]
      ]
    }
  })
}

// 新增：推送过滤设置界面
async function showPushFilters(ctx) {
  const prefs = getPrefs(ctx.from.id)
  const lang = prefs.lang
  
  // 新增：显示当前市值提醒数量
  let alertCount = 0
  for (const [tokenAddr, alertData] of marketCapAlerts) {
    if (alertData.users.has(ctx.from.id)) {
      alertCount++
    }
  }
  const alertText = lang === 'zh' ? `市值提醒: ${alertCount} 个代币` : `MC alerts: ${alertCount} tokens`
  
  const mediaText = lang === 'zh' ? (prefs.requireMediaLink ? '已开启' : '已关闭') : (prefs.requireMediaLink ? 'On' : 'Off')
  const mcText = prefs.mcUsdThreshold ? `$${prefs.mcUsdThreshold}` : (lang === 'zh' ? '未设置' : 'Not set')
  const title = lang === 'zh' ? '当前过滤：' : 'Current filters:'
  const body = lang === 'zh' 
    ? `媒体链接要求: ${mediaText}\n市值阈值: ${mcText}\n${alertText}`
    : `Require media link: ${mediaText}\nMC threshold: ${mcText}\n${alertText}`
  
  return ctx.reply(`${title}\n${body}`, {
    reply_markup: { inline_keyboard: [
      [ { text: prefs.requireMediaLink ? (lang === 'zh' ? '关闭媒体链接要求' : 'Disable media link requirement') : (lang === 'zh' ? '开启媒体链接要求' : 'Enable media link requirement'), callback_data: 'pf_media' } ],
      [ { text: lang === 'zh' ? '设置市值阈值' : 'Set MC threshold', callback_data: 'pf_mc_set' }, { text: lang === 'zh' ? '清除市值阈值' : 'Clear MC threshold', callback_data: 'pf_mc_clear' } ],
      [ { text: lang === 'zh' ? '📊 管理市值提醒' : '📊 Manage MC Alerts', callback_data: 'pf_manage_alerts' } ],
      [ { text: lang === 'zh' ? '⬅️ 返回' : '⬅️ Back', callback_data: 'm_back' } ]
    ] }
  })
}

// 新增：市值提醒管理界面
async function showMarketCapAlerts(ctx) {
  const userId = ctx.from.id
  const lang = getPrefs(userId).lang
  
  // 获取用户订阅的代币列表
  const userAlerts = []
  for (const [tokenAddr, alertData] of marketCapAlerts) {
    if (alertData.users.has(userId)) {
      userAlerts.push({ addr: tokenAddr, lastPushed: alertData.lastPushed })
    }
  }
  
  if (userAlerts.length === 0) {
    const text = lang === 'zh' 
      ? '📊 市值提醒管理\n\n您还没有订阅任何代币的市值提醒。\n\n💡 设置市值阈值后，新推送的代币会自动添加到提醒列表。'
      : '📊 Market Cap Alerts Management\n\nYou haven\'t subscribed to any token alerts yet.\n\n💡 After setting a market cap threshold, newly pushed tokens will be automatically added to the alert list.'
    
    return ctx.reply(text, {
      reply_markup: { inline_keyboard: [
        [ { text: lang === 'zh' ? '⬅️ 返回' : '⬅️ Back', callback_data: 'pf_back' } ]
      ] }
    })
  }
  
  // 显示用户订阅的代币列表
  let text = lang === 'zh' 
    ? `📊 市值提醒管理\n\n您当前订阅了 ${userAlerts.length} 个代币的市值提醒：\n\n`
    : `📊 Market Cap Alerts Management\n\nYou are currently subscribed to ${userAlerts.length} token alerts:\n\n`
  
  // 最多显示10个代币，避免消息过长
  const displayAlerts = userAlerts.slice(0, 10)
  for (let i = 0; i < displayAlerts.length; i++) {
    const alert = displayAlerts[i]
    const timeAgo = Math.floor((Date.now() - alert.lastPushed) / 1000 / 60) // 分钟
    const timeText = lang === 'zh' 
      ? `${timeAgo} 分钟前`
      : `${timeAgo} min ago`
    
    text += `${i + 1}. <code>${alert.addr.slice(0, 8)}...</code> (${timeText})\n`
  }
  
  if (userAlerts.length > 10) {
    text += lang === 'zh' 
      ? `\n... 还有 ${userAlerts.length - 10} 个代币`
      : `\n... and ${userAlerts.length - 10} more tokens`
  }
  
  text += lang === 'zh' 
    ? '\n\n💡 系统会每5分钟检查一次市值，达到阈值时自动推送提醒。'
    : '\n\n💡 The system checks market cap every 5 minutes and automatically sends alerts when thresholds are reached.'
  
  const buttons = []
  
  // 添加移除提醒的按钮（最多5个）
  const removeButtons = []
  for (let i = 0; i < Math.min(5, userAlerts.length); i++) {
    const alert = userAlerts[i]
    removeButtons.push({ 
      text: `${i + 1}`, 
      callback_data: `remove_alert_${alert.addr}` 
    })
  }
  if (removeButtons.length > 0) {
    buttons.push(removeButtons)
  }
  
  // 添加其他按钮
  buttons.push([
    { text: lang === 'zh' ? '🗑️ 清空所有提醒' : '🗑️ Clear All Alerts', callback_data: 'clear_all_alerts' },
    { text: lang === 'zh' ? '⬅️ 返回' : '⬅️ Back', callback_data: 'pf_back' }
  ])
  
  return ctx.reply(text, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: buttons }
  })
}

// Commands
bot.start(async (ctx) => {
  subscribedUsers.add(ctx.from.id)
  await showMenu(ctx)
})
bot.command('menu', (ctx) => showMenu(ctx))
bot.command('lang', (ctx) => {
  const arg = (ctx.message.text.split(/\s+/)[1] || '').toLowerCase()
  setLang(ctx.from.id, arg === 'zh' ? 'zh' : 'en')
  return showMenu(ctx)
})

// 新增：手动检查市值提醒状态
bot.command('mc_status', async (ctx) => {
  try {
    const userId = ctx.from.id
    const prefs = getPrefs(userId)
    const lang = prefs.lang
    
    let alertCount = 0
    for (const [tokenAddr, alertData] of marketCapAlerts) {
      if (alertData.users.has(userId)) {
        alertCount++
      }
    }
    
    const thresholdText = prefs.mcUsdThreshold 
      ? `$${prefs.mcUsdThreshold}`
      : (lang === 'zh' ? '未设置' : 'Not set')
    
    const statusText = lang === 'zh'
      ? `📊 市值提醒状态\n\n阈值: ${thresholdText}\n订阅代币数: ${alertCount}\n检查间隔: 5分钟\n\n💡 系统会自动监控代币市值，达到阈值时推送提醒。`
      : `📊 Market Cap Alert Status\n\nThreshold: ${thresholdText}\nSubscribed tokens: ${alertCount}\nCheck interval: 5 minutes\n\n💡 The system automatically monitors token market caps and sends alerts when thresholds are reached.`
    
    await ctx.reply(statusText)
  } catch (e) {
    await ctx.reply(`❌ 获取状态失败: ${e.message || e}`)
  }
})

// Callbacks
bot.on('callback_query', async (ctx) => {
  const data = ctx.callbackQuery?.data
  const prefs = getPrefs(ctx.from.id)
  
  if (data === 'm_lang') {
    await ctx.answerCbQuery()
    return ctx.reply(prefs.lang === 'zh' ? '请选择语言：' : 'Choose language:', {
      reply_markup: { inline_keyboard: [
        [ { text: 'English', callback_data: 'lang_en' }, { text: '中文', callback_data: 'lang_zh' } ],
        [ { text: prefs.lang === 'zh' ? '⬅️ 返回' : '⬅️ Back', callback_data: 'm_back' } ]
      ] }
    })
  }
  if (data === 'lang_en' || data === 'lang_zh') {
    setLang(ctx.from.id, data === 'lang_en' ? 'en' : 'zh')
    await ctx.answerCbQuery('OK')
    return showMenu(ctx)
  }
  if (data === 'm_filters') {
    await ctx.answerCbQuery()
    return showPushFilters(ctx)
  }
  if (data === 'pf_media') { 
    prefs.requireMediaLink = !prefs.requireMediaLink; 
    await ctx.answerCbQuery('OK'); 
    return showPushFilters(ctx) 
  }
  if (data === 'pf_mc_set') { 
    await ctx.answerCbQuery(); 
    return ctx.reply(prefs.lang === 'zh' ? '请输入市值阈值（USD，整数）' : 'Enter MC threshold in USD (integer):', { reply_markup: { force_reply: true } }) 
  }
  if (data === 'pf_mc_clear') { 
    prefs.mcUsdThreshold = null; 
    await ctx.answerCbQuery('OK'); 
    return showPushFilters(ctx) 
  }
  if (data === 'pf_manage_alerts') {
    await ctx.answerCbQuery()
    return showMarketCapAlerts(ctx)
  }
  if (data === 'pf_back') {
    await ctx.answerCbQuery()
    return showPushFilters(ctx)
  }
  if (data === 'm_back') { 
    await ctx.answerCbQuery(); 
    return showMenu(ctx) 
  }
  // 处理移除单个提醒
  if (data.startsWith('remove_alert_')) {
    const tokenAddr = data.replace('remove_alert_', '')
    removeFromMarketCapAlerts(tokenAddr, ctx.from.id)
    await ctx.answerCbQuery('已移除提醒')
    return showMarketCapAlerts(ctx)
  }
  // 处理清空所有提醒
  if (data === 'clear_all_alerts') {
    for (const [tokenAddr, alertData] of marketCapAlerts) {
      alertData.users.delete(ctx.from.id)
      if (alertData.users.size === 0) {
        marketCapAlerts.delete(tokenAddr)
      }
    }
    await ctx.answerCbQuery('已清空所有提醒')
    return showMarketCapAlerts(ctx)
  }
  if (data === 'm_status') {
    await ctx.answerCbQuery()
    const latest = await provider.getBlockNumber().catch(() => 0)
    return ctx.reply(`Watcher on\nFactory: ${PUMPU_FACTORY}\nLatest block: ${latest}\nSubscribers: ${subscribedUsers.size}`)
  }
  if (data === 'm_analyze') {
    await ctx.answerCbQuery()
    return ctx.reply(prefs.lang === 'zh' ? '请输入要分析的 Token 合约地址：' : 'Enter token contract address to analyze:', { reply_markup: { force_reply: true } })
  }
  await ctx.answerCbQuery()
})

// Handle replies for setting MC threshold
bot.on('message', async (ctx, next) => {
  const reply = ctx.message?.reply_to_message
  if (!reply) return next()
  
  const prefs = getPrefs(ctx.from.id)
  const n = Number((ctx.message.text || '').trim())
  if (!Number.isFinite(n) || n <= 0) return ctx.reply(prefs.lang === 'zh' ? '请输入正整数' : 'Please enter a positive integer')
  
  prefs.mcUsdThreshold = Math.floor(n)
  
  // 新增：设置阈值后，自动将已推送的代币添加到提醒列表
  let addedCount = 0
  for (const [tokenAddr, alertData] of marketCapAlerts) {
    if (!alertData.users.has(ctx.from.id)) {
      addToMarketCapAlerts(tokenAddr, ctx.from.id)
      addedCount++
    }
  }
  
  let message = prefs.lang === 'zh' 
    ? `已设置市值阈值: $${prefs.mcUsdThreshold}`
    : `MC threshold set: $${prefs.mcUsdThreshold}`
  
  if (addedCount > 0) {
    message += prefs.lang === 'zh'
      ? `\n已自动订阅 ${addedCount} 个已推送代币的市值提醒`
      : `\nAutomatically subscribed to ${addedCount} pushed tokens for MC alerts`
  }
  
  await ctx.reply(message)
  return showPushFilters(ctx)
})

// Real-time watcher (no backfill)
let lastProcessed = 0
const sentKeys = new Set()

// 启动市值检查定时器
setInterval(() => checkMarketCapAlerts(), MC_CHECK_INTERVAL)
console.log(`市值提醒检查已启动，间隔: ${MC_CHECK_INTERVAL/1000}秒`)

provider.on('block', async (bn) => {
  try {
    if (!lastProcessed) lastProcessed = bn - 1
    const from = lastProcessed + 1
    const to = bn
    if (from > to) return
    const topic0 = ethers.id('Deployed(address,uint256)')
    const logs = await provider.getLogs({ address: PUMPU_FACTORY, fromBlock: from, toBlock: to, topics: [topic0] })
    for (const log of logs) {
      try {
        const parsed = PUMPU_IFACE.parseLog(log)
        const addr = parsed.args?.[0]
        const amount = parsed.args?.[1] || 0n
        const key = `${addr}:${amount.toString()}`
        if (sentKeys.has(key)) continue
        sentKeys.add(key)

        // Enrich
        const meta = new ethers.Contract(addr, PUMPTOKEN_META_ABI, provider)
        const erc20 = new ethers.Contract(addr, ERC20_ABI, provider)
        const [descRaw, webRaw, tgRaw, twRaw, symbolRaw, decimalsRaw] = await Promise.all([
          meta.description().catch(() => ''),
          meta.website().catch(() => ''),
          meta.telegram().catch(() => ''),
          meta.twitter().catch(() => ''),
          erc20.symbol().catch(() => ''),
          erc20.decimals().catch(() => '')
        ])
        const toText = (v) => (v && String(v).trim().length > 0 ? String(v) : '无')
        const symbolText = toText(symbolRaw)
        const decimalsText = (decimalsRaw !== '' && decimalsRaw !== undefined && decimalsRaw !== null) ? String(decimalsRaw) : '无'
        const web = toText(webRaw)
        const tg = toText(tgRaw)
        const tw = toText(twRaw)
        const desc = toText(descRaw)

        // Push per-user with filters & language
        for (const uid of subscribedUsers) {
          try {
            const prefs = getPrefs(uid)
            if (prefs.requireMediaLink) {
              const hasMedia = [web, tg, tw].some((v) => v && v !== '无')
              if (!hasMedia) continue
            }
            const lines = prefs.lang === 'zh'
              ? [
                  '🚀 <b>新 PumpToken 上线</b>',
                  `合约: <code>${addr}</code>`,
                  `名称: ${symbolText}`,
                  `小数: ${decimalsText}`,
                  `Dev 买入: <b>${ethers.formatEther(amount)} OKB</b>`,
                  `简介: ${desc}`,
                  `官网: ${web}`,
                  `TG: ${tg}`,
                  `Twitter: ${tw}`,
                ]
              : [
                  '🚀 <b>New PumpToken Deployed</b>',
                  `Contract: <code>${addr}</code>`,
                  `Symbol: ${symbolText}`,
                  `Decimals: ${decimalsText}`,
                  `Dev Buy: <b>${ethers.formatEther(amount)} OKB</b>`,
                  `Description: ${desc}`,
                  `Website: ${web}`,
                  `TG: ${tg}`,
                  `Twitter: ${tw}`,
                ]
            await bot.telegram.sendMessage(uid, lines.join('\n'), { parse_mode: 'HTML' })
            
            // 新增：自动添加到市值提醒列表
            if (prefs.mcUsdThreshold) {
              addToMarketCapAlerts(addr, uid)
            }
          } catch {}
        }
      } catch {}
    }
    lastProcessed = to
  } catch {}
})

// Webhook server
const secretPath = `/webhook/${TG_BOT_TOKEN}`
const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === secretPath) {
    return bot.webhookCallback(secretPath)(req, res)
  }
  res.writeHead(200, { 'content-type': 'text/plain' })
  res.end('OK')
})
server.listen(Number(PORT), '0.0.0.0', async () => {
  console.log(`HTTP server listening on :${PORT}`)
  if (WEBHOOK_URL) {
    try {
      await bot.telegram.setWebhook(`${WEBHOOK_URL}${secretPath}`)
      console.log('Webhook set:', `${WEBHOOK_URL}${secretPath}`)
    } catch (e) {
      console.log('setWebhook failed:', e.message || e)
    }
  } else {
    console.log('Please set WEBHOOK_URL and call setWebhook manually:')
    console.log(`https://api.telegram.org/bot${TG_BOT_TOKEN}/setWebhook?url=<your_base_url>${secretPath}`)
  }
})


