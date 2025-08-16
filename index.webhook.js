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
function getPrefs(id) {
  if (!userPushPrefs.has(id)) userPushPrefs.set(id, { requireMediaLink: false, mcUsdThreshold: null, lang: 'en' })
  return userPushPrefs.get(id)
}
function setLang(id, lang) { getPrefs(id).lang = (lang === 'zh' ? 'zh' : 'en') }

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
    const media = prefs.lang === 'zh' ? (prefs.requireMediaLink ? '已开启' : '已关闭') : (prefs.requireMediaLink ? 'On' : 'Off')
    const mc = prefs.mcUsdThreshold ? `$${prefs.mcUsdThreshold}` : (prefs.lang === 'zh' ? '未设置' : 'Not set')
    const title = prefs.lang === 'zh' ? '当前过滤：' : 'Current filters:'
    return ctx.reply(`${title}\n${prefs.lang === 'zh' ? '媒体链接要求' : 'Require media link'}: ${media}\n${prefs.lang === 'zh' ? '市值阈值' : 'MC threshold'}: ${mc}`, {
      reply_markup: { inline_keyboard: [
        [ { text: prefs.requireMediaLink ? (prefs.lang === 'zh' ? '关闭媒体链接要求' : 'Disable media requirement') : (prefs.lang === 'zh' ? '开启媒体链接要求' : 'Enable media requirement'), callback_data: 'pf_media' } ],
        [ { text: prefs.lang === 'zh' ? '设置市值阈值' : 'Set MC threshold', callback_data: 'pf_mc_set' }, { text: prefs.lang === 'zh' ? '清除市值阈值' : 'Clear MC threshold', callback_data: 'pf_mc_clear' } ],
        [ { text: prefs.lang === 'zh' ? '⬅️ 返回' : '⬅️ Back', callback_data: 'm_back' } ]
      ] }
    })
  }
  if (data === 'pf_media') { prefs.requireMediaLink = !prefs.requireMediaLink; await ctx.answerCbQuery('OK'); return showMenu(ctx) }
  if (data === 'pf_mc_set') { await ctx.answerCbQuery(); return ctx.reply(prefs.lang === 'zh' ? '请输入市值阈值（USD，整数）' : 'Enter MC threshold in USD (integer):', { reply_markup: { force_reply: true } }) }
  if (data === 'pf_mc_clear') { prefs.mcUsdThreshold = null; await ctx.answerCbQuery('OK'); return showMenu(ctx) }
  if (data === 'm_status') {
    await ctx.answerCbQuery()
    const latest = await provider.getBlockNumber().catch(() => 0)
    return ctx.reply(`Watcher on\nFactory: ${PUMPU_FACTORY}\nLatest block: ${latest}\nSubscribers: ${subscribedUsers.size}`)
  }
  if (data === 'm_back') { await ctx.answerCbQuery(); return showMenu(ctx) }
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
  return showMenu(ctx)
})

// Real-time watcher (no backfill)
let lastProcessed = 0
const sentKeys = new Set()
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


