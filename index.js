require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const puppeteer = require('puppeteer-core');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

const {
  BROWSERLESS_WS,
  SITE_URL,
  ADMIN_EMAIL,
  ADMIN_PASS,
  API_SECRET
} = process.env;

// ================= uploads =================
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fsSync.existsSync(UPLOAD_DIR)) fsSync.mkdirSync(UPLOAD_DIR);
const upload = multer({ dest: UPLOAD_DIR });

// ================= cookies =================
const COOKIES_FILE = path.join(__dirname, 'cookies.json');

async function saveCookies(cookies) {
  await fs.writeFile(COOKIES_FILE, JSON.stringify(cookies), 'utf8');
}

async function loadCookies() {
  try {
    return JSON.parse(await fs.readFile(COOKIES_FILE, 'utf8'));
  } catch {
    return null;
  }
}

// ================= login (FIXED) =================
async function ensureLoggedIn(page) {
  const cookies = await loadCookies();

  // محاولة الدخول بالكويكز
  if (cookies?.length) {
    await page.setCookie(...cookies);
    await page.goto(`${SITE_URL}/wp-admin/`, { waitUntil: 'networkidle2' });

    const ok =
      (await page.$('#wpadminbar')) ||
      (await page.$('body.wp-admin'));

    if (ok) return;
  }

  // تسجيل دخول جديد
  await page.goto(`${SITE_URL}/wp-login.php`, {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });

  await page.waitForSelector('#user_login', { visible: true, timeout: 30000 });
  await page.type('#user_login', ADMIN_EMAIL, { delay: 20 });

  await page.waitForSelector('#user_pass', { visible: true, timeout: 30000 });
  await page.type('#user_pass', ADMIN_PASS, { delay: 20 });

  await Promise.all([
    page.click('#wp-submit'),
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 })
  ]);

  // ===== تحقق ذكي =====
  const loginError = await page.$('#login_error');
  if (loginError) {
    const msg = await page.$eval('#login_error', el => el.innerText);
    throw new Error('Login failed: ' + msg);
  }

  const loggedIn =
    (await page.$('#wpadminbar')) ||
    (await page.$('body.wp-admin')) ||
    page.url().includes('/wp-admin');

  if (!loggedIn) {
    throw new Error('Login failed: dashboard not detected');
  }

  await saveCookies(await page.cookies());
}

// ================= publish =================
app.post('/publish', upload.single('image'), async (req, res) => {
  let browser;
  const imageFile = req.file;

  try {
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ') || auth.split(' ')[1] !== API_SECRET) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    const { title, content, category } = req.body;
    if (!title || !content) {
      return res.status(400).json({ ok: false, error: 'Missing title or content' });
    }

    browser = await puppeteer.connect({
      browserWSEndpoint: BROWSERLESS_WS
    });

    const page = await browser.newPage();
    await ensureLoggedIn(page);

    // صفحة إضافة مقال
    await page.goto(`${SITE_URL}/wp-admin/post-new.php`, {
      waitUntil: 'networkidle2',
      timeout: 60000
    });

    // TinyMCE
    await page.waitForFunction(() => window.tinymce && tinymce.activeEditor);

    // العنوان
    await page.waitForSelector('#title', { visible: true });
    await page.type('#title', title, { delay: 20 });

    // المحتوى
    const frameEl = await page.waitForSelector('#content_ifr', { visible: true });
    const frame = await frameEl.contentFrame();
    await frame.waitForSelector('body', { visible: true });
    await frame.focus('body');
    await frame.type('body', content, { delay: 5 });

    // التصنيف
    if (category) {
      const catSel = `input[name="post_category[]"][value="${category}"]`;
      await page.waitForSelector(catSel, { visible: true });
      const checked = await page.$eval(catSel, el => el.checked);
      if (!checked) await page.click(catSel);
    }

    // الصورة البارزة
    if (!imageFile) {
      return res.status(400).json({ ok: false, error: 'Image is required' });
    }

    await page.click('#set-post-thumbnail');
    await page.waitForSelector('.media-modal', { visible: true });

    await page.click('#menu-item-upload');
    await page.waitForSelector('.media-modal input[type="file"]', { visible: true });

    const fileInput = await page.$('.media-modal input[type="file"]');
    await fileInput.uploadFile(imageFile.path);

    await page.waitForSelector('.media-button-select', { visible: true, timeout: 60000 });
    await page.click('.media-button-select');

    await page.waitForTimeout(3000);

    // نشر
    await page.waitForSelector('#publish:not([disabled])', { visible: true });

    await page.evaluate(() => {
      document.querySelector('#publish').scrollIntoView({
        behavior: 'instant',
        block: 'center'
      });
    });

    await page.click('#publish');

    await page.waitForSelector('#message.updated, #message.notice-success', {
      timeout: 60000
    });

    return res.json({ ok: true, message: 'تم نشر المقال بنجاح' });

  } catch (err) {
    console.error('❌ ERROR:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  } finally {
    if (browser) await browser.disconnect().catch(() => {});
    if (imageFile) await fs.unlink(imageFile.path).catch(() => {});
  }
});

// ================= health =================
app.get('/', (req, res) => res.send('wp-publisher up'));

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

