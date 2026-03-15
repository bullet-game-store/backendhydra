require('dotenv').config();

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

let nodemailer = null;
try {
  nodemailer = require('nodemailer');
} catch (_) {
  nodemailer = null;
}

const PORT = Number(process.env.PORT || 3000);
const STORE_PATH = path.join(__dirname, 'hydra_autopay_orders.json');
const INVENTORY_PATH = path.join(__dirname, 'hydra_inventory.json');
const SEPAY_API_KEY = String(process.env.SEPAY_API_KEY || '').trim();

const PAYMENT_CONFIG = {
  bankName: 'MB Bank',
  bankBin: '970422',
  accountNo: '0794527008',
  accountName: 'TRAN NGUYEN CHUONG',
  memoFormat: 'HYDRA + tên game viết tắt + mã đơn'
};

const MAIL_CONFIG = {
  user: String(process.env.GMAIL_USER || '').trim(),
  pass: String(process.env.GMAIL_APP_PASSWORD || '').trim(),
  from: String(process.env.MAIL_FROM || process.env.GMAIL_USER || '').trim(),
  storeName: String(process.env.STORE_NAME || 'Hydra Store').trim(),
  supportPhone: String(process.env.SUPPORT_PHONE || '0794527008').trim(),
  supportEmail: String(process.env.SUPPORT_EMAIL || process.env.GMAIL_USER || '').trim()
};

function loadJsonFile(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function saveJsonFile(filePath, payload) {
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
}

function normalizeMemo(memo = '') {
  return String(memo).trim().toUpperCase().replace(/\s+/g, ' ');
}

function normalizeTitle(title = '') {
  return String(title || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function ensureStoreShape(store) {
  if (!store || !Array.isArray(store.orders)) return { orders: [] };
  return store;
}

function loadStore() {
  return ensureStoreShape(loadJsonFile(STORE_PATH, { orders: [] }));
}

function saveStore(store) {
  saveJsonFile(STORE_PATH, ensureStoreShape(store));
}

function loadInventory() {
  const data = loadJsonFile(INVENTORY_PATH, []);
  return Array.isArray(data) ? data : [];
}

function saveInventory(inventory) {
  saveJsonFile(INVENTORY_PATH, Array.isArray(inventory) ? inventory : []);
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Api-Key'
  });
  res.end(JSON.stringify(payload));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 2 * 1024 * 1024) {
        reject(new Error('PAYLOAD_TOO_LARGE'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('INVALID_JSON'));
      }
    });
    req.on('error', reject);
  });
}

function maskEmail(email = '') {
  const value = String(email || '').trim();
  const [name, domain] = value.split('@');
  if (!name || !domain) return value;
  if (name.length <= 2) return `${name[0] || '*'}*@${domain}`;
  return `${name.slice(0, 2)}***@${domain}`;
}

function mailReady() {
  return Boolean(nodemailer && MAIL_CONFIG.user && MAIL_CONFIG.pass && MAIL_CONFIG.from);
}

function createTransporter() {
  if (!mailReady()) return null;
  return nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: {
      user: MAIL_CONFIG.user,
      pass: MAIL_CONFIG.pass
    }
  });
}

function getOrderByCode(code) {
  const store = loadStore();
  const normalized = String(code || '').trim();
  return store.orders.find(order => order.code === normalized) || null;
}

function upsertOrder(input) {
  const store = loadStore();
  const code = String(input.code || '').trim();
  if (!code) {
    throw new Error('MISSING_ORDER_CODE');
  }

  const existingIndex = store.orders.findIndex(order => order.code === code);
  const previous = existingIndex >= 0 ? store.orders[existingIndex] : {};

  const order = {
    code,
    memo: input.memo !== undefined ? normalizeMemo(input.memo) : normalizeMemo(previous.memo),
    total: input.total !== undefined ? Number(input.total || 0) : Number(previous.total || 0),
    totalText: input.totalText !== undefined ? input.totalText : (previous.totalText || ''),
    name: input.name !== undefined ? input.name : (previous.name || ''),
    phone: input.phone !== undefined ? input.phone : (previous.phone || ''),
    buyerEmail: input.buyerEmail !== undefined ? String(input.buyerEmail || '').trim().toLowerCase() : (previous.buyerEmail || ''),
    note: input.note !== undefined ? input.note : (previous.note || ''),
    items: Array.isArray(input.items) ? input.items : (Array.isArray(previous.items) ? previous.items : []),
    status: input.status || previous.status || 'pending',
    account: input.account !== undefined ? input.account : (previous.account || ''),
    password: input.password !== undefined ? input.password : (previous.password || ''),
    deliveredNote: input.deliveredNote !== undefined ? input.deliveredNote : (previous.deliveredNote || ''),
    paidAt: input.paidAt !== undefined ? input.paidAt : (previous.paidAt || ''),
    deliveredAt: input.deliveredAt !== undefined ? input.deliveredAt : (previous.deliveredAt || ''),
    emailSentAt: input.emailSentAt !== undefined ? input.emailSentAt : (previous.emailSentAt || ''),
    emailMessageId: input.emailMessageId !== undefined ? input.emailMessageId : (previous.emailMessageId || ''),
    emailError: input.emailError !== undefined ? input.emailError : (previous.emailError || ''),
    emailDeliveryStatus: input.emailDeliveryStatus !== undefined ? input.emailDeliveryStatus : (previous.emailDeliveryStatus || ''),
    paymentSource: input.paymentSource !== undefined ? input.paymentSource : (previous.paymentSource || ''),
    paymentPayload: input.paymentPayload !== undefined ? input.paymentPayload : (previous.paymentPayload || null),
    createdAt: previous.createdAt || input.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  if (existingIndex >= 0) store.orders[existingIndex] = order;
  else store.orders.unshift(order);
  saveStore(store);
  return order;
}

function extractOrderCode(text = '') {
  const match = String(text || '').toUpperCase().match(/\bHD[A-Z0-9]{4,}\b/);
  return match ? match[0].trim() : '';
}

function findOrderByPayload(payload) {
  const store = loadStore();
  const code = String(payload.code || '').trim() || extractOrderCode(payload.memo || payload.content || payload.description || '');
  const memo = normalizeMemo(payload.memo || payload.content || payload.description || '');
  const total = Number(payload.total || payload.amount || payload.transferAmount || 0);

  if (code) {
    const byCode = store.orders.find(order => order.code === code);
    if (byCode) return byCode;
  }

  return store.orders.find(order => {
    const sameMemo = memo && order.memo === memo;
    const sameAmount = total > 0 ? Number(order.total) === total : true;
    return sameMemo && sameAmount;
  }) || null;
}

function buildItemsText(items) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return '- Chưa có thông tin sản phẩm';
  return list.map(item => `- ${item.title || 'Game'} x${item.qty || 1}`).join('\n');
}

function buildDeliveryEmail(order) {
  const text = [
    `Cảm ơn bạn đã mua hàng tại ${MAIL_CONFIG.storeName}.`,
    '',
    `Mã đơn: ${order.code}`,
    `Nội dung chuyển khoản: ${order.memo || ''}`,
    `Sản phẩm:`,
    buildItemsText(order.items),
    '',
    `Tài khoản game: ${order.account || ''}`,
    `Mật khẩu: ${order.password || ''}`,
    `Ghi chú: ${order.deliveredNote || 'Không có'}`,
    '',
    `Hỗ trợ: ${MAIL_CONFIG.supportPhone}${MAIL_CONFIG.supportEmail ? ` | ${MAIL_CONFIG.supportEmail}` : ''}`,
    '',
    `${MAIL_CONFIG.storeName}`
  ].join('\n');

  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;line-height:1.7;color:#172033;background:#f6f9ff;padding:24px">
      <div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #d9e4ff;border-radius:18px;overflow:hidden">
        <div style="padding:22px 24px;background:linear-gradient(135deg,#55e7c8,#38c6ff);color:#08111e">
          <h2 style="margin:0;font-size:24px">${MAIL_CONFIG.storeName} - Giao tài khoản</h2>
          <div style="margin-top:6px;font-size:14px">Mã đơn: <strong>${order.code}</strong></div>
        </div>
        <div style="padding:24px">
          <p style="margin-top:0">Cảm ơn bạn đã mua hàng tại <strong>${MAIL_CONFIG.storeName}</strong>.</p>
          <div style="margin:18px 0;padding:16px;border-radius:14px;background:#f7fbff;border:1px solid #e4edff">
            <div><strong>Nội dung chuyển khoản:</strong> ${order.memo || ''}</div>
            <div><strong>Người nhận:</strong> ${PAYMENT_CONFIG.accountName}</div>
          </div>
          <div style="margin:18px 0;padding:16px;border-radius:14px;background:#fffdf6;border:1px solid #ffe4a8">
            <div style="margin-bottom:8px"><strong>Tài khoản game:</strong> ${order.account || ''}</div>
            <div style="margin-bottom:8px"><strong>Mật khẩu:</strong> ${order.password || ''}</div>
            <div><strong>Ghi chú:</strong> ${order.deliveredNote || 'Không có'}</div>
          </div>
          <div style="margin:18px 0">
            <strong>Sản phẩm:</strong>
            <pre style="white-space:pre-wrap;font-family:inherit;background:#f7fbff;border:1px solid #e4edff;border-radius:14px;padding:14px;margin-top:10px">${buildItemsText(order.items)}</pre>
          </div>
          <p style="margin:0">Hỗ trợ: <strong>${MAIL_CONFIG.supportPhone}</strong>${MAIL_CONFIG.supportEmail ? ` • ${MAIL_CONFIG.supportEmail}` : ''}</p>
        </div>
      </div>
    </div>
  `;

  return { text, html };
}

async function sendDeliveryEmail(order, { forceResend = false } = {}) {
  if (!order || !order.code) {
    return { sent: false, skipped: true, reason: 'ORDER_NOT_FOUND' };
  }
  if (!order.buyerEmail) {
    return { sent: false, skipped: true, reason: 'MISSING_BUYER_EMAIL' };
  }
  if (!mailReady()) {
    return { sent: false, skipped: true, reason: 'MAIL_NOT_CONFIGURED' };
  }
  if (order.emailSentAt && !forceResend) {
    return { sent: true, skipped: true, reason: 'ALREADY_SENT', deliveredTo: order.buyerEmail };
  }

  const transporter = createTransporter();
  if (!transporter) {
    return { sent: false, skipped: true, reason: 'TRANSPORT_NOT_READY' };
  }

  const mail = buildDeliveryEmail(order);
  const info = await transporter.sendMail({
    from: `${MAIL_CONFIG.storeName} <${MAIL_CONFIG.from}>`,
    to: order.buyerEmail,
    subject: `${MAIL_CONFIG.storeName} - Giao tài khoản đơn ${order.code}`,
    text: mail.text,
    html: mail.html
  });

  const updated = upsertOrder({
    code: order.code,
    emailSentAt: new Date().toISOString(),
    emailMessageId: info.messageId || '',
    emailError: '',
    emailDeliveryStatus: 'sent'
  });

  return {
    sent: true,
    skipped: false,
    messageId: info.messageId || '',
    deliveredTo: updated.buyerEmail
  };
}

function findInventoryItemIndex(inventory, title) {
  const target = normalizeTitle(title);
  let idx = inventory.findIndex(item => item.status === 'available' && normalizeTitle(item.gameTitle) === target);
  if (idx >= 0) return idx;
  idx = inventory.findIndex(item => item.status === 'available' && normalizeTitle(item.gameTitle).includes(target));
  if (idx >= 0) return idx;
  idx = inventory.findIndex(item => item.status === 'available' && target.includes(normalizeTitle(item.gameTitle)));
  return idx;
}

function allocateInventoryForOrder(order) {
  if (order.account && order.password) {
    return {
      account: order.account,
      password: order.password,
      note: order.deliveredNote || ''
    };
  }

  const items = Array.isArray(order.items) ? order.items : [];
  const firstItem = items[0];
  if (!firstItem || !firstItem.title) {
    throw new Error('MISSING_ORDER_ITEM');
  }

  const inventory = loadInventory();
  const idx = findInventoryItemIndex(inventory, firstItem.title);
  if (idx < 0) {
    throw new Error('OUT_OF_STOCK');
  }

  const selected = inventory[idx];
  inventory[idx] = {
    ...selected,
    status: 'delivered',
    orderCode: order.code,
    reservedAt: selected.reservedAt || new Date().toISOString(),
    deliveredAt: new Date().toISOString()
  };
  saveInventory(inventory);

  return {
    account: selected.account || '',
    password: selected.password || '',
    note: selected.note || 'Đăng nhập Steam theo hướng dẫn, tải game xong hãy chuyển offline trước khi vào game.'
  };
}

async function deliverOrder(payload, { forceResend = false } = {}) {
  const existing = getOrderByCode(payload.code);
  const baseOrder = { ...(existing || {}), ...payload };
  const allocation = allocateInventoryForOrder(baseOrder);

  const deliveredOrder = upsertOrder({
    ...baseOrder,
    account: payload.account || allocation.account,
    password: payload.password || allocation.password,
    deliveredNote: payload.deliveredNote || allocation.note,
    status: 'delivered',
    paidAt: payload.paidAt || existing?.paidAt || new Date().toISOString(),
    deliveredAt: payload.deliveredAt || new Date().toISOString()
  });

  let emailResult = { sent: false, skipped: true, reason: 'NOT_ATTEMPTED' };
  try {
    emailResult = await sendDeliveryEmail(deliveredOrder, { forceResend });
  } catch (error) {
    upsertOrder({
      code: deliveredOrder.code,
      emailError: String(error.message || error),
      emailDeliveryStatus: 'failed'
    });
    emailResult = {
      sent: false,
      skipped: false,
      reason: 'SEND_FAILED',
      error: String(error.message || error)
    };
  }

  const latest = getOrderByCode(deliveredOrder.code) || deliveredOrder;
  return { order: latest, emailResult };
}

function getWebhookHeader(req, name) {
  return String(req.headers[name] || '').trim();
}

function sepayAuthorized(req) {
  if (!SEPAY_API_KEY) return true;
  const auth = getWebhookHeader(req, 'authorization');
  const apiKey = getWebhookHeader(req, 'x-api-key');
  const normalizedAuth = auth.replace(/^apikey\s+/i, '').trim();
  return normalizedAuth === SEPAY_API_KEY || apiKey === SEPAY_API_KEY;
}

function pickString(...values) {
  for (const value of values) {
    const text = String(value || '').trim();
    if (text) return text;
  }
  return '';
}

function pickNumber(...values) {
  for (const value of values) {
    const num = Number(value);
    if (Number.isFinite(num) && num > 0) return num;
  }
  return 0;
}

function parseWebhookPayload(body) {
  const memoText = pickString(
    body.content,
    body.description,
    body.transferContent,
    body.transfer_description,
    body.memo,
    body.desc,
    body.transactionContent
  );

  const amount = pickNumber(
    body.transferAmount,
    body.amount,
    body.creditAmount,
    body.transactionAmount,
    body.value
  );

  const type = pickString(body.transferType, body.transactionType, body.type, body.entryType).toLowerCase();
  const code = extractOrderCode(memoText) || String(body.code || '').trim();

  return {
    raw: body,
    memo: normalizeMemo(memoText),
    code,
    amount,
    type,
    paidAt: pickString(body.transactionDate, body.createdAt, body.paidAt) || new Date().toISOString(),
    reference: pickString(body.referenceCode, body.reference, body.id, body.transId)
  };
}

function isIncomingWebhook(parsed) {
  if (!parsed.type) return true;
  return ['in', 'credit', 'receive', 'received', 'tien_vao', 'moneyin'].some(keyword => parsed.type.includes(keyword));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'OPTIONS') {
    return sendJson(res, 204, {});
  }

  if (req.method === 'GET' && url.pathname === '/api/health') {
    return sendJson(res, 200, {
      ok: true,
      port: PORT,
      paymentConfig: PAYMENT_CONFIG,
      mail: {
        enabled: mailReady(),
        configuredUser: MAIL_CONFIG.user ? maskEmail(MAIL_CONFIG.user) : '',
        from: MAIL_CONFIG.from ? maskEmail(MAIL_CONFIG.from) : ''
      },
      sepayWebhookReady: true,
      inventoryCount: loadInventory().length
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/payment/config') {
    return sendJson(res, 200, {
      ...PAYMENT_CONFIG,
      mailEnabled: mailReady()
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/orders') {
    return sendJson(res, 200, ensureStoreShape(loadStore()));
  }

  if (req.method === 'POST' && url.pathname === '/api/payments/check') {
    try {
      const payload = await readJsonBody(req);
      if (!payload.code) {
        return sendJson(res, 400, { error: 'MISSING_ORDER_CODE' });
      }

      const existing = getOrderByCode(payload.code);
      if (!existing) {
        upsertOrder(payload);
      } else {
        upsertOrder({
          code: payload.code,
          memo: payload.memo,
          total: payload.total,
          totalText: payload.totalText,
          name: payload.name,
          phone: payload.phone,
          buyerEmail: payload.buyerEmail,
          note: payload.note,
          items: payload.items,
          status: existing.status || payload.status || 'pending'
        });
      }

      const matched = getOrderByCode(payload.code) || findOrderByPayload(payload);
      const delivered = matched?.status === 'delivered';
      const paid = ['paid', 'delivered'].includes(matched?.status);

      return sendJson(res, 200, {
        paid,
        delivered,
        status: matched?.status || 'pending',
        account: delivered ? matched.account : '',
        password: delivered ? matched.password : '',
        note: delivered ? matched.deliveredNote : '',
        emailSent: Boolean(matched?.emailSentAt),
        deliveredTo: matched?.buyerEmail || '',
        emailStatus: matched?.emailDeliveryStatus || (matched?.emailSentAt ? 'sent' : ''),
        paymentConfig: PAYMENT_CONFIG,
        order: matched || null
      });
    } catch (error) {
      return sendJson(res, 400, { error: error.message || 'BAD_REQUEST' });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/payments/mark-paid') {
    try {
      const payload = await readJsonBody(req);
      if (!payload.code) {
        return sendJson(res, 400, { error: 'MISSING_ORDER_CODE' });
      }

      if (payload.delivered) {
        const { order, emailResult } = await deliverOrder(payload, { forceResend: Boolean(payload.forceResendEmail) });
        return sendJson(res, 200, {
          ok: true,
          order,
          emailSent: Boolean(emailResult.sent),
          emailSkipped: Boolean(emailResult.skipped),
          emailReason: emailResult.reason || '',
          deliveredTo: order.buyerEmail || '',
          emailError: emailResult.error || ''
        });
      }

      const order = upsertOrder({
        ...payload,
        status: 'paid',
        paidAt: new Date().toISOString()
      });
      return sendJson(res, 200, { ok: true, order, emailSent: false });
    } catch (error) {
      return sendJson(res, 400, { error: error.message || 'BAD_REQUEST' });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/payments/resend-email') {
    try {
      const payload = await readJsonBody(req);
      if (!payload.code) {
        return sendJson(res, 400, { error: 'MISSING_ORDER_CODE' });
      }
      const order = getOrderByCode(payload.code);
      if (!order) {
        return sendJson(res, 404, { error: 'ORDER_NOT_FOUND' });
      }
      const emailResult = await sendDeliveryEmail(order, { forceResend: true });
      return sendJson(res, 200, {
        ok: true,
        code: order.code,
        emailSent: Boolean(emailResult.sent),
        deliveredTo: order.buyerEmail || '',
        reason: emailResult.reason || '',
        messageId: emailResult.messageId || ''
      });
    } catch (error) {
      return sendJson(res, 400, { error: String(error.message || error) });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/sepay-webhook') {
    try {
      if (!sepayAuthorized(req)) {
        return sendJson(res, 401, { ok: false, error: 'INVALID_SEPAY_API_KEY' });
      }

      const body = await readJsonBody(req);
      const parsed = parseWebhookPayload(body);

      if (!isIncomingWebhook(parsed)) {
        return sendJson(res, 200, { ok: true, ignored: true, reason: 'NOT_INCOMING_TRANSACTION' });
      }

      const order = findOrderByPayload({
        code: parsed.code,
        memo: parsed.memo,
        total: parsed.amount
      });

      if (!order) {
        return sendJson(res, 404, {
          ok: false,
          error: 'ORDER_NOT_FOUND',
          code: parsed.code,
          memo: parsed.memo,
          amount: parsed.amount
        });
      }

      if (order.status === 'delivered') {
        return sendJson(res, 200, {
          ok: true,
          alreadyDelivered: true,
          code: order.code,
          deliveredTo: order.buyerEmail || '',
          emailSent: Boolean(order.emailSentAt)
        });
      }

      const { order: deliveredOrder, emailResult } = await deliverOrder({
        ...order,
        status: 'delivered',
        paidAt: parsed.paidAt,
        paymentSource: 'sepay',
        paymentPayload: parsed.raw
      });

      return sendJson(res, 200, {
        ok: true,
        code: deliveredOrder.code,
        status: deliveredOrder.status,
        deliveredTo: deliveredOrder.buyerEmail || '',
        emailSent: Boolean(emailResult.sent),
        emailSkipped: Boolean(emailResult.skipped),
        emailReason: emailResult.reason || '',
        emailError: emailResult.error || ''
      });
    } catch (error) {
      return sendJson(res, 400, { ok: false, error: String(error.message || error) });
    }
  }

  return sendJson(res, 404, { error: 'NOT_FOUND' });
});

server.listen(PORT, () => {
  console.log(`Hydra backend đang chạy tại http://localhost:${PORT}`);
  console.log(`Tài khoản nhận tiền: ${PAYMENT_CONFIG.bankName} - ${PAYMENT_CONFIG.accountNo}`);
  console.log(`Gửi Gmail: ${mailReady() ? 'ĐÃ BẬT' : 'CHƯA CẤU HÌNH'}`);
  console.log(`SePay webhook: /api/sepay-webhook ${SEPAY_API_KEY ? '(có kiểm tra API key)' : '(không kiểm tra API key)'}`);
  if (!nodemailer) {
    console.log('Thiếu package nodemailer. Chạy: npm install nodemailer');
  }
});
