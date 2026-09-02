'use strict';

require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const { Bot, Keyboard, InlineKeyboard, webhookCallback } = require('grammy');
const { openStore } = require('./storage');

const PORT = Number(process.env.PORT) || 8788;
const ADMIN_IDS = String(process.env.ADMIN_IDS || '')
  .split(',')
  .map(function (id) { return String(id).trim(); })
  .filter(Boolean);

const PLANS = {
  minute: { ms: 60 * 1000, label: 'دقيقة واحدة (تجربة)' },
  weekly: { ms: 7 * 24 * 60 * 60 * 1000, label: 'أسبوع' },
  monthly: { ms: 30 * 24 * 60 * 60 * 1000, label: 'شهر' },
  lifetime: { ms: 0, label: 'دائم' }
};

var store = null;
var storeKind = 'file';
var mysqlStatus = 'not_configured';

function normalizeKey(raw) {
  return String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function hashKey(raw) {
  return crypto.createHash('sha256').update(normalizeKey(raw)).digest('hex');
}

function randomToken() {
  return crypto.randomBytes(32).toString('hex');
}

function generateKey() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  function chunk() {
    var out = '';
    for (var i = 0; i < 4; i++) out += alphabet[crypto.randomInt(alphabet.length)];
    return out;
  }
  return 'QLAI-' + chunk() + '-' + chunk() + '-' + chunk();
}

function isAdmin(id) {
  return ADMIN_IDS.indexOf(String(id)) >= 0;
}

function planExpiresAt(plan, fromMs) {
  var spec = PLANS[plan];
  if (!spec) return null;
  if (plan === 'lifetime') return null;
  return new Date(fromMs + spec.ms);
}

function rowExpired(row, now) {
  if (!row) return true;
  if (row.status === 'revoked' || row.status === 'expired') return true;
  if (!row.expires_at) return false;
  return new Date(row.expires_at).getTime() <= now;
}

function publicLicense(row) {
  return {
    ok: true,
    name: row.display_name || '',
    plan: row.plan,
    lifetime: row.plan === 'lifetime',
    expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
    token: row.session_token
  };
}

async function createLicense(plan, adminId) {
  if (!PLANS[plan]) throw new Error('plan');
  for (var attempt = 0; attempt < 8; attempt++) {
    var key = generateKey();
    try {
      await store.insertUnused({
        key_hash: hashKey(key),
        key_suffix: key.slice(-4),
        plan: plan,
        created_by: adminId
      });
      return key;
    } catch (err) {
      if (err && err.code === 'ER_DUP_ENTRY') continue;
      throw err;
    }
  }
  throw new Error('keygen');
}

async function activateLicense(name, key, deviceId) {
  var now = Date.now();
  var hash = hashKey(key);
  var cleanName = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!cleanName) return { ok: false, error: 'name' };
  if (normalizeKey(key).length < 12) return { ok: false, error: 'invalid' };
  if (!deviceId || String(deviceId).length < 8) return { ok: false, error: 'device' };

  var row = await store.findByHash(hash);
  if (!row) return { ok: false, error: 'invalid' };
  if (row.status === 'revoked') return { ok: false, error: 'revoked' };
  if (rowExpired(row, now) && row.status !== 'unused') {
    await store.update(row.id, { status: 'expired' });
    return { ok: false, error: 'expired' };
  }
  if (row.status === 'active') {
    if (row.device_id && row.device_id !== deviceId) return { ok: false, error: 'device' };
    var keepToken = row.session_token || randomToken();
    row = await store.update(row.id, {
      session_token: keepToken,
      display_name: cleanName,
      last_seen_at: new Date()
    });
    return publicLicense(row);
  }

  var token = randomToken();
  var expires = planExpiresAt(row.plan, now);
  row = await store.update(row.id, {
    status: 'active',
    display_name: cleanName,
    device_id: deviceId,
    session_token: token,
    activated_at: new Date(),
    expires_at: expires,
    last_seen_at: new Date()
  });
  return publicLicense(row);
}

async function statusLicense(token, deviceId) {
  var now = Date.now();
  if (!token || !deviceId) return { ok: false, error: 'invalid' };
  var row = await store.findBySession(token, deviceId);
  if (!row) return { ok: false, error: 'invalid' };
  if (row.status === 'revoked') return { ok: false, error: 'revoked' };
  if (rowExpired(row, now)) {
    await store.update(row.id, { status: 'expired' });
    return { ok: false, error: 'expired' };
  }
  await store.update(row.id, { last_seen_at: new Date() });
  return publicLicense(row);
}

const activateHits = {};
function rateLimited(ip) {
  var now = Date.now();
  var bucket = activateHits[ip] || [];
  bucket = bucket.filter(function (t) { return now - t < 60000; });
  if (bucket.length >= 12) {
    activateHits[ip] = bucket;
    return true;
  }
  bucket.push(now);
  activateHits[ip] = bucket;
  return false;
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(function (_req, res, next) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  next();
});
app.use(express.json({ limit: '32kb' }));
app.options('*', function (_req, res) { res.status(204).end(); });

app.get('/v1/health', function (_req, res) {
  res.json({ ok: true, service: 'ql-ai-license', store: storeKind, mysql: mysqlStatus });
});

app.post('/v1/activate', async function (req, res) {
  try {
    var ip = String(req.ip || 'local');
    if (rateLimited(ip)) return res.status(429).json({ ok: false, error: 'rate' });
    var body = req.body || {};
    var result = await activateLicense(body.name, body.key, body.deviceId);
    res.status(result.ok ? 200 : 400).json(result);
  } catch (_err) {
    res.status(500).json({ ok: false, error: 'server' });
  }
});

app.post('/v1/status', async function (req, res) {
  try {
    var body = req.body || {};
    var result = await statusLicense(body.token, body.deviceId);
    res.status(result.ok ? 200 : 400).json(result);
  } catch (_err) {
    res.status(500).json({ ok: false, error: 'server' });
  }
});

function planLabel(plan) {
  return (PLANS[plan] && PLANS[plan].label) || plan || '—';
}

function statusLabel(row) {
  if (!row) return 'غير معروف';
  if (row.status === 'revoked') return 'ملغى';
  if (row.status === 'unused') return 'غير مفعّل';
  if (rowExpired(row, Date.now())) return 'منتهي';
  return 'نشط';
}

function subscriberName(row) {
  var name = String(row && row.display_name || '').trim();
  if (name) return name;
  return 'بدون اسم · ' + (row && row.key_suffix ? row.key_suffix : '?');
}

function remainText(row) {
  if (!row) return '';
  if (row.plan === 'lifetime') return 'دائم';
  if (!row.expires_at) return '—';
  var ms = new Date(row.expires_at).getTime() - Date.now();
  if (ms <= 0) return 'انتهى';
  var min = Math.ceil(ms / 60000);
  if (min < 90) return 'متبقّي ' + min + ' د';
  var hours = Math.ceil(min / 60);
  if (hours < 48) return 'متبقّي ' + hours + ' س';
  return 'متبقّي ' + Math.ceil(hours / 24) + ' يوم';
}

async function requireAdmin(ctx) {
  if (isAdmin(ctx.from && ctx.from.id)) return true;
  try { await ctx.answerCallbackQuery({ text: 'غير مصرّح', show_alert: true }); } catch (_) {}
  try { await ctx.reply('هذا البوت مخصص للإدارة فقط.'); } catch (_) {}
  return false;
}

async function changeSubscriberPlan(id, plan) {
  if (!PLANS[plan]) return null;
  var row = await store.findById(id);
  if (!row) return null;
  var patch = {
    plan: plan,
    status: row.status === 'unused' ? 'unused' : 'active',
    expires_at: plan === 'lifetime' ? null : planExpiresAt(plan, Date.now())
  };
  if (row.status === 'revoked' || row.status === 'expired') {
    patch.status = row.device_id ? 'active' : 'unused';
  }
  if (patch.status === 'unused') {
    patch.expires_at = null;
  }
  return store.update(id, patch);
}

async function revokeSubscriber(id) {
  var row = await store.findById(id);
  if (!row) return null;
  return store.update(id, {
    status: 'revoked',
    session_token: null
  });
}

function userMenuKeyboard(row) {
  return new InlineKeyboard()
    .text('إلغاء الاشتراك', 'rv:' + row.id).row()
    .text('أسبوعي', 'pl:' + row.id + ':weekly')
    .text('شهري', 'pl:' + row.id + ':monthly')
    .text('دائم', 'pl:' + row.id + ':lifetime').row()
    .text('تجربة دقيقة', 'pl:' + row.id + ':minute')
    .text('رجوع للقائمة', 'ls');
}

function subscribersKeyboard(rows) {
  var kb = new InlineKeyboard();
  var active = rows.filter(function (row) {
    return row.status === 'active' && !rowExpired(row, Date.now());
  });
  active.slice(0, 20).forEach(function (row) {
    var label = subscriberName(row);
    if (label.length > 24) label = label.slice(0, 22) + '…';
    kb.text(label, 'u:' + row.id).text('إلغاء', 'rv:' + row.id).row();
  });
  kb.text('تحديث القائمة', 'ls');
  return kb;
}

async function sendSubscribersList(ctx) {
  var rows = await store.listAll();
  var now = Date.now();
  var active = rows.filter(function (row) { return row.status === 'active' && !rowExpired(row, now); });
  var unused = rows.filter(function (row) { return row.status === 'unused'; });
  var ended = rows.filter(function (row) {
    return row.status === 'revoked' || row.status === 'expired' || (row.status === 'active' && rowExpired(row, now));
  });
  var names = active.map(function (row, index) {
    return (index + 1) + '. ' + subscriberName(row) + ' — ' + planLabel(row.plan) + ' — ' + remainText(row);
  }).join('\n');
  var text = 'المشتركون\n\n' +
    'النشطون: ' + active.length + '\n' +
    'مفاتيح غير مفعّلة: ' + unused.length + '\n' +
    'منتهون / ملغون: ' + ended.length + '\n\n' +
    (names || 'لا يوجد مشتركون نشطون حالياً.') +
    '\n\nكل اسم جنبه إلغاء. اضغط الاسم لتبديل الخطة.';
  var kb = subscribersKeyboard(rows);
  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, { reply_markup: kb });
      return;
    } catch (_) {}
  }
  return ctx.reply(text, { reply_markup: kb });
}

async function sendUserCard(ctx, id) {
  var row = await store.findById(id);
  if (!row) return ctx.reply('المستخدم غير موجود.');
  var text = subscriberName(row) +
    '\nالحالة: ' + statusLabel(row) +
    '\nالخطة: ' + planLabel(row.plan) +
    '\nالمدة: ' + remainText(row) +
    '\nالمفتاح: …' + (row.key_suffix || '');
  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, { reply_markup: userMenuKeyboard(row) });
      return;
    } catch (_) {}
  }
  return ctx.reply(text, { reply_markup: userMenuKeyboard(row) });
}

function telegramKeyboard() {
  return new Keyboard()
    .text('تجربة دقيقة').text('أسبوعي').row()
    .text('شهري').text('دائم').row()
    .text('المشتركون')
    .resized();
}

async function sendNewKey(ctx, plan) {
  if (!isAdmin(ctx.from && ctx.from.id)) {
    return ctx.reply('هذا البوت مخصص للإدارة فقط.');
  }
  var key = await createLicense(plan, ctx.from.id);
  var spec = PLANS[plan];
  return ctx.reply(
    'تم إنشاء المفتاح\n\n<code>' + key + '</code>\n\nالمدة: ' + spec.label + '\nيُستخدم مرة واحدة على جهاز واحد.',
    { parse_mode: 'HTML', reply_markup: telegramKeyboard() }
  );
}

var bot = null;
if (process.env.TELEGRAM_BOT_TOKEN) {
  bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);
  bot.catch(function () {});
  attachBotHandlers(bot);
}

function attachBotHandlers(bot) {
  bot.command('start', async function (ctx) {
    if (!isAdmin(ctx.from && ctx.from.id)) {
      return ctx.reply('هذا البوت مخصص للإدارة فقط.');
    }
    return ctx.reply(
      'QL AI — إدارة الاشتراكات\n\nأنشئ مفتاحاً، أو افتح المشتركين لمعرفة العدد والأسماء وإلغاء أو تبديل الخطة.\n\n/min تجربة دقيقة\n/week أسبوعي\n/month شهري\n/life دائم\n/list المشتركون',
      { reply_markup: telegramKeyboard() }
    );
  });

  bot.command('min', function (ctx) { return sendNewKey(ctx, 'minute'); });
  bot.command('week', function (ctx) { return sendNewKey(ctx, 'weekly'); });
  bot.command('month', function (ctx) { return sendNewKey(ctx, 'monthly'); });
  bot.command('life', function (ctx) { return sendNewKey(ctx, 'lifetime'); });
  bot.command('list', async function (ctx) {
    if (!(await requireAdmin(ctx))) return;
    return sendSubscribersList(ctx);
  });

  bot.hears('تجربة دقيقة', function (ctx) { return sendNewKey(ctx, 'minute'); });
  bot.hears('أسبوعي', function (ctx) { return sendNewKey(ctx, 'weekly'); });
  bot.hears('شهري', function (ctx) { return sendNewKey(ctx, 'monthly'); });
  bot.hears('دائم', function (ctx) { return sendNewKey(ctx, 'lifetime'); });
  bot.hears('المشتركون', async function (ctx) {
    if (!(await requireAdmin(ctx))) return;
    return sendSubscribersList(ctx);
  });

  bot.callbackQuery('ls', async function (ctx) {
    if (!(await requireAdmin(ctx))) return;
    try { await ctx.answerCallbackQuery(); } catch (_) {}
    return sendSubscribersList(ctx);
  });

  bot.callbackQuery(/^u:(\d+)$/, async function (ctx) {
    if (!(await requireAdmin(ctx))) return;
    try { await ctx.answerCallbackQuery(); } catch (_) {}
    return sendUserCard(ctx, ctx.match[1]);
  });

  bot.callbackQuery(/^rv:(\d+)$/, async function (ctx) {
    if (!(await requireAdmin(ctx))) return;
    var row = await revokeSubscriber(ctx.match[1]);
    try {
      await ctx.answerCallbackQuery({
        text: row ? 'تم إلغاء الاشتراك' : 'غير موجود',
        show_alert: true
      });
    } catch (_) {}
    return sendSubscribersList(ctx);
  });

  bot.callbackQuery(/^pl:(\d+):(minute|weekly|monthly|lifetime)$/, async function (ctx) {
    if (!(await requireAdmin(ctx))) return;
    var row = await changeSubscriberPlan(ctx.match[1], ctx.match[2]);
    try {
      await ctx.answerCallbackQuery({
        text: row ? 'تم تبديل الخطة إلى ' + planLabel(ctx.match[2]) : 'تعذر التبديل',
        show_alert: true
      });
    } catch (_) {}
    if (row) return sendUserCard(ctx, row.id);
    return sendSubscribersList(ctx);
  });
}

async function listenHttp() {
  return new Promise(function (resolve, reject) {
    var server = app.listen(PORT, '0.0.0.0', function () {
      resolve(server);
    });
    server.on('error', reject);
  });
}

function publicBaseUrl() {
  return String(process.env.WEBHOOK_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
}

async function startTelegram() {
  if (!bot) {
    process.stderr.write('TELEGRAM_BOT_TOKEN missing — API only\n');
    return;
  }
  var base = publicBaseUrl();
  var hookPath = '/telegram-webhook';
  if (base) {
    var secret = process.env.TELEGRAM_WEBHOOK_SECRET || '';
    var opts = { drop_pending_updates: true };
    if (secret) opts.secret_token = secret;
    var lastErr = null;
    for (var i = 0; i < 6; i++) {
      try {
        await bot.api.setWebhook(base + hookPath, opts);
        return;
      } catch (err) {
        lastErr = err;
        await new Promise(function (resolve) { setTimeout(resolve, 2500); });
      }
    }
    process.stderr.write('telegram webhook failed: ' + (lastErr && lastErr.message ? lastErr.message : lastErr) + '\n');
    return;
  }
  await bot.start({ drop_pending_updates: true });
}

async function start() {
  var opened = await openStore();
  store = opened.store;
  storeKind = opened.kind;
  mysqlStatus = opened.mysql || 'not_configured';
  var base = publicBaseUrl();
  if (base && bot) {
    var secret = process.env.TELEGRAM_WEBHOOK_SECRET || '';
    app.use('/telegram-webhook', webhookCallback(bot, 'express', secret ? { secretToken: secret } : {}));
  }
  await listenHttp();
  await startTelegram();
}

start().catch(function (err) {
  process.stderr.write(String(err && err.message ? err.message : err) + '\n');
  process.exit(1);
});
