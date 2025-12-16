require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const puppeteer = require('puppeteer-core');
const multer = require('multer');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

const {
  SITE_URL,
  BROWSERLESS_WS,
  ADMIN_EMAIL,
  ADMIN_PASS,
  API_SECRET
} = process.env;

/* ================= UPLOAD ================= */
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fsSync.existsSync(UPLOAD_DIR)) fsSync.mkdirSync(UPLOAD_DIR);
const upload = multer({ dest: UPLOAD_DIR });

/* ================= LOGIN ================= */
async function ensureLoggedIn(page) {
  console.log('🔐 Opening login page');

  await page.goto(`${SITE_URL}/wp-login.php`, {
    waitUntil: 'domcontentloaded',
    timeout: 120000
  });

  await page.waitForSelector('#user_login', { visible: true, timeout: 60000 });
  await page.type('#user_login', ADMIN_EMAIL, { delay: 25 });

  await page.waitForSelector('#user_pass', { visible: true, timeout: 60000 });
  await page.type('#user_pass', ADMIN_PASS, { delay: 25 });

  await Promise.all([
    page.click('#wp-submit'),
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 120000 })
  ]);

  const loggedIn = await page.$('#wpadminbar');
  if (!loggedIn) {
    const error = await page.$('#login_error');
    if (error) {
      const msg = await page.$eval('#login_error', el => el.innerText);
      throw new Error(`Login failed: ${msg}`);
    }
    throw new Error('Login failed: wpadminbar not found');
  }

  console.log('✅ Logged in');
}

/* ================= PUBLISH ================= */
app.post('/publish', upload.single('image'), async (req, res) => {
  let browser;
  const image = req.file;

  try {
    /* ---------- AUTH ---------- */
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${API_SECRET}`) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    const { title, content, category } = req.body;
    if (!title || !content || !image) {
      return res.status(400).json({ ok: false, error: 'Missing data' });
    }

    /* ---------- BROWSER ---------- */
    browser = await puppeteer.connect({
      browserWSEndpoint: BROWSERLESS_WS
    });

    const page = await browser.newPage();
    page.setDefaultTimeout(180000);

    await ensureLoggedIn(page);

    /* ---------- OPEN POST ---------- */
    console.log('📝 Opening new post');
    await page.goto(`${SITE_URL}/wp-admin/post-new.php`, {
      waitUntil: 'networkidle2',
      timeout: 120000
    });

    /* ---------- TITLE ---------- */
    await page.waitForSelector('#title', { visible: true });
    await page.type('#title', title, { delay: 20 });

    /* ---------- CONTENT (TinyMCE SAFE) ---------- */
    console.log('✍️ Writing content');
    const frameHandle = await page.waitForSelector('#content_ifr', { timeout: 60000 });
    const frame = await frameHandle.contentFrame();

    await frame.evaluate((html) => {
      document.body.innerHTML = html;
    }, content);

    /* ---------- CATEGORY ---------- */
    if (category) {
      console.log('🏷 Selecting category:', category);

      // افتح صندوق التصنيفات لو مسكّر
      await page.evaluate(() => {
        const box = document.querySelector('#categorydiv');
        if (box && box.classList.contains('closed')) {
          box.querySelector('.handlediv')?.click();
        }
      });

      const checkbox = `input[name="post_category[]"][value="${category}"]`;
      await page.waitForSelector(checkbox, { visible: true, timeout: 60000 });

      const checked = await page.$eval(checkbox, el => el.checked);
      if (!checked) {
        await page.click(checkbox);
      }
    }

    /* ---------- FEATURED IMAGE ---------- */
    console.log('🖼 Uploading featured image');
    await page.click('#set-post-thumbnail');

    
// انتظر فتح media modal نفسه
await page.waitForSelector('.media-modal', { timeout: 60000 });

// حاول تفتح تبويب "رفع ملفات" لو موجود
await page.evaluate(() => {
  const buttons = document.querySelectorAll('.media-router button');
  if (!buttons.length) return;

  const uploadTab = [...buttons].find(btn =>
    btn.innerText.includes('رفع') || btn.innerText.includes('Upload')
  );

  if (uploadTab) uploadTab.click();
});

// انتظر input رفع الملف الحقيقي
await page.waitForSelector('input[type="file"]', {
  visible: true,
  timeout: 60000
});

// ارفع الصورة
const fileInput = await page.$('input[type="file"]');
await fileInput.uploadFile(image.path);

// انتظر زر "تعيين صورة بارزة / Set featured image"
await page.waitForSelector('.media-button-select', {
  visible: true,
  timeout: 60000
});

// اضغطه
await page.click('.media-button-select');

// مهلة صغيرة للاستقرار

await page.click('.media-button-select');
await new Promise(resolve => setTimeout(resolve, 3000));
    
    /* ---------- PUBLISH ---------- */
    console.log('🚀 Publishing post');
    await page.click('#publish');

    await page.waitForFunction(
      () =>
        document.body.innerText.includes('تم') ||
        document.body.innerText.includes('Published'),
      { timeout: 120000 }
    );

    return res.json({ ok: true, message: 'تم نشر المقال بنجاح' });

  } catch (err) {
    console.error('❌ publish error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  } finally {
    if (browser) await browser.disconnect().catch(() => {});
    if (image) await fs.unlink(image.path).catch(() => {});
  }
});

/* ================= HEALTH ================= */
app.get('/', (_, res) => res.send('WP publisher running'));

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});


