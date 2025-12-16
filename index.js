require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const puppeteer = require('puppeteer-core');
const multer = require('multer');
const fs = require('fs').promises;
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

// uploads (مؤقت)
const UPLOAD_DIR = path.join(__dirname, 'uploads');
require('fs').existsSync(UPLOAD_DIR) || require('fs').mkdirSync(UPLOAD_DIR);
const upload = multer({ dest: UPLOAD_DIR });

/* ================= LOGIN ================= */
async function ensureLoggedIn(page) {
  console.log('🔐 Opening login page');

  await page.goto(`${SITE_URL}/wp-login.php`, {
    waitUntil: 'domcontentloaded',
    timeout: 120000
  });

  await page.waitForSelector('#user_login', { visible: true, timeout: 60000 });
  await page.type('#user_login', ADMIN_EMAIL, { delay: 30 });

  await page.waitForSelector('#user_pass', { visible: true, timeout: 60000 });
  await page.type('#user_pass', ADMIN_PASS, { delay: 30 });

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

  console.log('✅ Logged in successfully');
}

/* ================= PUBLISH ================= */
app.post('/publish', upload.single('image'), async (req, res) => {
  let browser;
  const image = req.file;

  try {
    // auth
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${API_SECRET}`) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    const { title, content, category } = req.body;
    if (!title || !content || !image) {
      return res.status(400).json({ ok: false, error: 'Missing data' });
    }

    browser = await puppeteer.connect({
      browserWSEndpoint: BROWSERLESS_WS
    });

    const page = await browser.newPage();
    page.setDefaultTimeout(180000);

    await ensureLoggedIn(page);

    console.log('📝 Opening new post page');
    await page.goto(`${SITE_URL}/wp-admin/post-new.php`, {
      waitUntil: 'networkidle2',
      timeout: 120000
    });

    // title
    await page.waitForSelector('#title', { visible: true });
    await page.type('#title', title, { delay: 20 });

    // TinyMCE content (آمن وسريع)
    console.log('✍️ Writing content');
    const frameHandle = await page.waitForSelector('#content_ifr', { timeout: 60000 });
    const frame = await frameHandle.contentFrame();

    await frame.evaluate((html) => {
      document.body.innerHTML = html;
    }, content);

    // category
    if (category) {
      console.log('🏷 Selecting category');
      await page.click(`#in-category-${category}`);
    }

    // featured image
    console.log('🖼 Uploading image');
    await page.click('#set-post-thumbnail');
    await page.waitForSelector('input[type="file"]', { visible: true });

    const fileInput = await page.$('input[type="file"]');
    await fileInput.uploadFile(image.path);

    await page.waitForSelector('.media-button-select', { visible: true, timeout: 60000 });
    await page.click('.media-button-select');

    await page.waitForTimeout(3000);

    // publish
    console.log('🚀 Publishing');
    await page.click('#publish');

    await page.waitForFunction(
      () => document.body.innerText.includes('تم') || document.body.innerText.includes('Published'),
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
