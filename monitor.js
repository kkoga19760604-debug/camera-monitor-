const { chromium } = require('playwright');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// =================【設定情報】=================
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || 'YOUR_DISCORD_WEBHOOK_URL';
const MIN_PROFIT = 0; // 0円以上の利益で通知
const INTERVAL_MS = 3000; // 各商品ごとのアクセス間隔
// ==============================================

const HISTORY_FILE = path.join(__dirname, 'notified.json');

let notifiedList = [];
if (fs.existsSync(HISTORY_FILE)) {
  try {
    notifiedList = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
  } catch (e) {
    notifiedList = [];
  }
}

const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 買取一丁目価格取得 (JANコードベース)
async function fetchKaitoriPrice(jan) {
  if (!jan) return null;
  const url = `https://www.1-chome.com/api/index/findByKeyword?page=1&size=24&keyword=${jan}`;
  try {
    const response = await axios.get(url, {
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

// マップカメラの全新品商品を自動収集
async function fetchAllMapCameraNewProducts(page) {
  console.log('[全件調査] マップカメラの全新品商品リストを自動収集しています...');
  const newProducts = [];
  
  // マップカメラの主要新品カテゴリ（デジタル一眼・ミラーレス・レンズ）
  const categoryUrls = [
    'https://www.mapcamera.com/search?category=1&sell=1', // デジタル一眼・ミラーレス新品
    'https://www.mapcamera.com/search?category=2&sell=1'  // 交換レンズ新品
  ];

  for (const catUrl of categoryUrls) {
    try {
      await page.goto(catUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(3000);

      const items = await page.evaluate(() => {
        const list = [];
        const itemNodes = document.querySelectorAll('.item-box, .shohin_box, .list_item, tr[class*="item"]');
        itemNodes.forEach(node => {
          const aTag = node.querySelector('a[href*="/item/"]');
          const priceNode = node.querySelector('.selling-price, .price_shohin, .goods-price, .price');
          const titleNode = node.querySelector('.item-name, .title, a[href*="/item/"]');
          
          if (aTag && priceNode) {
            const href = aTag.href;
            const janMatch = href.match(/\/item\/([0-9]{13})/);
            const price = parseInt(priceNode.innerText.replace(/[^0-9]/g, ''), 10);
            const name = titleNode ? titleNode.innerText.trim() : '新品商品';
            
            if (janMatch && price > 10000) {
              list.push({ jan: janMatch[1], name: name, mapPrice: price });
            }
          }
        });
        return list;
      });

      for (const item of items) {
        if (!newProducts.some(p => p.jan === item.jan)) {
          newProducts.push(item);
        }
      }
    } catch (e) {
      console.log(`[情報] カテゴリクローリング継続 (${catUrl}): ${e.message}`);
    }
  }

  // 補完: targets.json の商品も全件スキャンリストに合体
  const TARGETS_FILE = path.join(__dirname, 'targets.json');
  if (fs.existsSync(TARGETS_FILE)) {
    try {
      const fixedTargets = JSON.parse(fs.readFileSync(TARGETS_FILE, 'utf-8'));
      for (const t of fixedTargets) {
        if (!newProducts.some(p => p.jan === t.jan)) {
          newProducts.push({ jan: t.jan, name: t.name, mapPrice: null });
        }
      }
    } catch (e) {}
  }

  console.log(`[全件調査完了] 収集した新品商品数: 全${newProducts.length}件`);
  return newProducts;
}

// 補完用: 楽天マップカメラ公式ストアから新品価格を全自動バックアップ取得
async function fetchMapCameraBackupPrice(jan) {
  const rakutenUrl = `https://item.rakuten.co.jp/mapcamera/${jan}/`;
  try {
    const res = await axios.get(rakutenUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
      timeout: 8000
    });
    const match = res.data.match(/id=\"ratPrice\" value=\"([0-9]+)\"/) || res.data.match(/\"ratPrice\":\s*\"([0-9]+)\"/);
    if (match && match[1]) {
      return parseInt(match[1], 10);
    }
  } catch (e) {}
  return null;
}

async function sendDiscordNotification(data) {
  if (!DISCORD_WEBHOOK_URL || DISCORD_WEBHOOK_URL.includes('YOUR_DISCORD_WEBHOOK_URL')) return;
  const payload = {
    embeds: [
      {
        title: '🔥 マップカメラ ＞ 買取一丁目 サヤ取り（全新品スキャン）検知！',
        description: `**商品名**: ${data.name}\n**JANコード**: \`${data.jan}\``,
        color: 16729156,
        fields: [
          { name: '📊 マップカメラ（新品販売価格）', value: `\`${data.mapPrice.toLocaleString()} 円\``, inline: true },
          { name: '💰 買取一丁目（新品買取価格）', value: `\`${data.kaitoriPrice.toLocaleString()} 円\``, inline: true },
          { name: '✨ 獲得可能利益', value: `**+${data.profit.toLocaleString()} 円**`, inline: false }
        ],
        url: `https://www.mapcamera.com/item/${data.jan}`,
        timestamp: new Date().toISOString()
      }
    ]
  };
  try {
    await axios.post(DISCORD_WEBHOOK_URL, payload, { headers: { 'Content-Type': 'application/json' } });
    console.log(`[通知発信] Discordへサヤ取り通知を送信しました: ${data.name} (+${data.profit.toLocaleString()}円)`);
  } catch (error) {
    console.error(`[エラー] Discord通知送信失敗: ${error.message}`);
  }
}

async function main() {
  console.log(`全新品カメラ・レンズ全自動スキャンモニターを起動しました。(通知基準: ${MIN_PROFIT}円以上)`);

  const useLocalChrome = fs.existsSync(CHROME_PATH);
  const launchOptions = {
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-setuid-sandbox']
  };
  if (useLocalChrome) {
    launchOptions.executablePath = CHROME_PATH;
  }

  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    locale: 'ja-JP'
  });

  const page = await context.newPage();
  await page.addInitScript(() => {
    delete Object.getPrototypeOf(navigator).webdriver;
  });

  try {
    await page.goto('https://www.mapcamera.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);
  } catch (e) {}

  // マップカメラの全新品商品を動的に全件取得
  const products = await fetchAllMapCameraNewProducts(page);

  console.log(`\n--- 全件価格照合プロセス開始 (対象: ${products.length}件) ---`);

  for (let i = 0; i < products.length; i++) {
    const prod = products[i];
    console.log(`\n[全件スキャン ${i+1}/${products.length}] ${prod.name} (JAN: ${prod.jan})`);

    let mapPrice = prod.mapPrice;
    if (!mapPrice) {
      mapPrice = await fetchMapCameraBackupPrice(prod.jan);
    }

    const kaitoriPrice = await fetchKaitoriPrice(prod.jan);

    if (mapPrice && kaitoriPrice) {
      const profit = kaitoriPrice - mapPrice;
      console.log(`-> マップカメラ価格: ${mapPrice.toLocaleString()}円 | 買取一丁目: ${kaitoriPrice.toLocaleString()}円 | 差額: ${profit > 0 ? '+' : ''}${profit.toLocaleString()}円`);

      if (profit >= MIN_PROFIT && !notifiedList.includes(prod.jan)) {
        await sendDiscordNotification({
          name: prod.name,
          jan: prod.jan,
          mapPrice: mapPrice,
          kaitoriPrice: kaitoriPrice,
          profit: profit
        });
        notifiedList.push(prod.jan);
        fs.writeFileSync(HISTORY_FILE, JSON.stringify(notifiedList, null, 2), 'utf-8');
      }
    } else {
      console.log(`-> 価格状況: マップカメラ=${mapPrice ? mapPrice.toLocaleString() + '円' : '要確認'}, 買取一丁目=${kaitoriPrice ? kaitoriPrice.toLocaleString() + '円' : '買取対象外'}`);
    }

    await sleep(INTERVAL_MS);
  }

  await browser.close();
  console.log('\n--- 全件スキャン完了 ---');
}

main();
