const { chromium } = require('playwright');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// =================【設定情報】=================
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || 'YOUR_DISCORD_WEBHOOK_URL';
const MIN_PROFIT = 0;
const INTERVAL_MS = 12000;
// ==============================================

const TARGETS_FILE = path.join(__dirname, 'targets.json');
const HISTORY_FILE = path.join(__dirname, 'notified.json');

let notifiedList = [];
if (fs.existsSync(HISTORY_FILE)) {
  try {
    notifiedList = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
  } catch (e) {
    notifiedList = [];
  }
}

let targets = [];
if (fs.existsSync(TARGETS_FILE)) {
  try {
    targets = JSON.parse(fs.readFileSync(TARGETS_FILE, 'utf-8'));
  } catch (e) {
    targets = [
      { "jan": "4548736122604", "name": "SONY α1 ボディ (ILCE-1)" },
      { "jan": "4548736130678", "name": "SONY α7 IV ボディ (ILCE-7M4)" },
      { "jan": "4548736162075", "name": "SONY α1 II ボディ (ILCE-1M2)" }
    ];
    fs.writeFileSync(TARGETS_FILE, JSON.stringify(targets, null, 2), 'utf-8');
  }
}

const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 買取一丁目価格取得 (JANコード)
async function fetchKaitoriPrice(jan) {
  // 1. JANコード直接検索
  let url = `https://www.1-chome.com/api/index/findByKeyword?page=1&size=24&keyword=${jan}`;
  try {
    let response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)',
        'Referer': 'https://www.1-chome.com/'
      },
      timeout: 10000
    });
    if (response.data && response.data.code === 200 && response.data.data && response.data.data.content.length > 0) {
      for (const product of response.data.data.content) {
        if (product.goodsKbDetails && product.goodsKbDetails.length > 0) {
          for (const detail of product.goodsKbDetails) {
            if (detail.kbDetailName.includes('新品') || detail.kbDetailName.includes('最大')) {
              return detail.kbDetailPrice || detail.maxPrice;
            }
          }
        }
      }
    }
  } catch (e) {}
  return null;
}

// マップカメラ本店価格取得 (ハイブリッド取得: 本店直リンク + 公式ストア補完)
async function fetchMapCameraPrice(page, jan) {
  // 1. 本店直リンクでのパース試行
  const mapUrl = `https://www.mapcamera.com/item/${jan}`;
  try {
    console.log(`[巡回] マップカメラ本店アクセス (JAN: ${jan}): ${mapUrl}`);
    const response = await page.goto(mapUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    if (response.status() === 200) {
      await page.waitForTimeout(2000);
      const price = await page.evaluate(() => {
        const selectors = ['.selling-price', '.price_shohin', '.goods-price', '.est-map-price', '.price_new', '.item-price', '.price'];
        for (const selector of selectors) {
          const el = document.querySelector(selector);
          if (el) {
            const txt = el.innerText.replace(/[^0-9]/g, '');
            if (txt && parseInt(txt, 10) > 10000) return parseInt(txt, 10);
          }
        }
        const bodyText = document.body.innerText;
        if (bodyText.includes('新品') && !bodyText.includes('Access Denied')) {
          const matches = bodyText.match(/¥\s?[0-9,]+/g) || bodyText.match(/￥\s?[0-9,]+/g);
          if (matches && matches.length > 0) {
            for (const m of matches) {
              const num = parseInt(m.replace(/[^0-9]/g, ''), 10);
              if (num > 10000) return num;
            }
          }
        }
        return null;
      });
      if (price) return price;
    }
  } catch (e) {}

  // 2. WAFブロック等の補完: マップカメラ公式ストアAPI/商品データからの確実な価格取得
  const rakutenUrl = `https://item.rakuten.co.jp/mapcamera/${jan}/`;
  try {
    console.log(`[補完] マップカメラ公式情報取得 (JAN: ${jan}): ${rakutenUrl}`);
    const res = await axios.get(rakutenUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
      timeout: 10000
    });
    const match = res.data.match(/id=\"ratPrice\" value=\"([0-9]+)\"/) || res.data.match(/\"ratPrice\":\s*\"([0-9]+)\"/);
    if (match && match[1]) {
      const price = parseInt(match[1], 10);
      console.log(`-> マップカメラ公式価格確定: ${price.toLocaleString()}円`);
      return price;
    }
  } catch (e) {}

  return null;
}

async function sendDiscordNotification(data) {
  if (!DISCORD_WEBHOOK_URL || DISCORD_WEBHOOK_URL.includes('YOUR_DISCORD_WEBHOOK_URL')) return;
  const payload = {
    embeds: [
      {
        title: '🔥 マップカメラ本店 ＞ 買取一丁目 サヤ取り検知！',
        description: `**商品名**: ${data.name}\n**JANコード**: \`${data.jan}\``,
        color: 16729156,
        fields: [
          { name: '📊 マップカメラ本店（販売価格）', value: `\`${data.mapPrice.toLocaleString()} 円\``, inline: true },
          { name: '💰 買取一丁目（買取価格）', value: `\`${data.kaitoriPrice.toLocaleString()} 円\``, inline: true },
          { name: '✨ 獲得可能利益', value: `**+${data.profit.toLocaleString()} 円**`, inline: false }
        ],
        url: `https://www.mapcamera.com/item/${data.jan}`,
        timestamp: new Date().toISOString()
      }
    ]
  };
  try {
    await axios.post(DISCORD_WEBHOOK_URL, payload, { headers: { 'Content-Type': 'application/json' } });
    console.log(`[通知] Discordへ通知を送信しました: ${data.name}`);
  } catch (error) {
    console.error(`[エラー] Discord通知送信失敗: ${error.message}`);
  }
}

async function main() {
  console.log(`価格比較モニターを起動しました。対象商品数: ${targets.length}件 (通知基準: ${MIN_PROFIT}円以上)`);

  const useLocalChrome = fs.existsSync(CHROME_PATH);
  const launchOptions = {
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-setuid-sandbox']
  };
  if (useLocalChrome) {
    console.log(`[ブラウザ] 実Chromeを使用します: ${CHROME_PATH}`);
    launchOptions.executablePath = CHROME_PATH;
  }

  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo'
  });

  const page = await context.newPage();
  await page.addInitScript(() => {
    delete Object.getPrototypeOf(navigator).webdriver;
  });

  try {
    await page.goto('https://www.mapcamera.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);
  } catch (e) {}

  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    console.log(`\n[処理中 ${i+1}/${targets.length}] ${target.name} (JAN: ${target.jan})`);

    if (notifiedList.includes(target.jan)) continue;

    const mapPrice = await fetchMapCameraPrice(page, target.jan);
    const kaitoriPrice = await fetchKaitoriPrice(target.jan);

    if (mapPrice && kaitoriPrice) {
      const profit = kaitoriPrice - mapPrice;
      console.log(`-> 本店価格: ${mapPrice.toLocaleString()}円 | 買取: ${kaitoriPrice.toLocaleString()}円 | 差額: ${profit.toLocaleString()}円`);

      if (profit >= MIN_PROFIT) {
        await sendDiscordNotification({
          name: target.name,
          jan: target.jan,
          mapPrice: mapPrice,
          kaitoriPrice: kaitoriPrice,
          profit: profit
        });
        notifiedList.push(target.jan);
        fs.writeFileSync(HISTORY_FILE, JSON.stringify(notifiedList, null, 2), 'utf-8');
      }
    } else {
      console.log(`-> 価格取得状況: マップカメラ=${mapPrice ? mapPrice.toLocaleString() + '円' : '取得不可'}, 買取一丁目=${kaitoriPrice ? kaitoriPrice.toLocaleString() + '円' : '取得不可'}`);
    }
    await sleep(INTERVAL_MS);
  }
  await browser.close();
}

main();
