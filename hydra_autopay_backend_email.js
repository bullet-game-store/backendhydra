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

const PAYMENT_CONFIG = {
  bankName: 'MB Bank',
  bankBin: '970422',
  accountNo: '0794527008',
  accountName: 'TRAN NGUYEN CHUONG',
  memoFormat: 'Tên game viết tắt + mã đơn'
};

const MAIL_CONFIG = {
  user: String(process.env.GMAIL_USER || '').trim(),
  pass: String(process.env.GMAIL_APP_PASSWORD || '').trim(),
  from: String(process.env.MAIL_FROM || process.env.GMAIL_USER || '').trim(),
  storeName: String(process.env.STORE_NAME || 'Hydra Store').trim(),
  supportPhone: String(process.env.SUPPORT_PHONE || '0794527008').trim(),
  supportEmail: String(process.env.SUPPORT_EMAIL || process.env.GMAIL_USER || '').trim()
};

function loadStore() {
  try {
    if (!fs.existsSync(STORE_PATH)) return { orders: [] };
    const raw = fs.readFileSync(STORE_PATH, 'utf8');
    const parsed = JSON.parse(raw || '{"orders":[]}');
    if (!parsed || !Array.isArray(parsed.orders)) return { orders: [] };
    return parsed;
  } catch {
    return { orders: [] };
  }
}

function saveStore(store) {
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), 'utf8');
}

function normalizeMemo(memo = '') {
  return String(memo).trim().toUpperCase().replace(/\s+/g, ' ');
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
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

function ensureStoreShape(store) {
  if (!store || !Array.isArray(store.orders)) return { orders: [] };
  return store;
}

function upsertOrder(input) {
  const store = ensureStoreShape(loadStore());
  const code = String(input.code || '').trim();
  const existingIndex = store.orders.findIndex(order => order.code === code);
  const previous = existingIndex >= 0 ? store.orders[existingIndex] : {};

  const order = {
    code,
    memo: input.memo !== undefined ? normalizeMemo(input.memo) : normalizeMemo(previous.memo),
    total: input.total !== undefined ? Number(input.total || 0) : Number(previous.total || 0),
    totalText: input.totalText !== undefined ? input.totalText : (previous.totalText || ''),
    name: input.name !== undefined ? input.name : (previous.name || ''),
    phone: input.phone !== undefined ? input.phone : (previous.phone || ''),
    buyerEmail: input.buyerEmail !== undefined ? String(input.buyerEmail || '').trim() : (previous.buyerEmail || ''),
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
    createdAt: previous.createdAt || input.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  if (existingIndex >= 0) store.orders[existingIndex] = order;
  else store.orders.unshift(order);
  saveStore(store);
  return order;
}

function getOrderByCode(code) {
  const store = ensureStoreShape(loadStore());
  const normalized = String(code || '').trim();
  return store.orders.find(order => order.code === normalized) || null;
}

function findOrderByPayload(payload) {
  const store = ensureStoreShape(loadStore());
  const code = String(payload.code || '').trim();
  const memo = normalizeMemo(payload.memo);
  const total = Number(payload.total || 0);

  if (code) {
    const byCode = store.orders.find(order => order.code === code);
    if (byCode) return byCode;
  }

  return store.orders.find(order => order.memo === memo && Number(order.total) === total) || null;
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

async function deliverOrder(payload, { forceResend = false } = {}) {
  const deliveredOrder = upsertOrder({
    ...payload,
    status: 'delivered',
    paidAt: payload.paidAt || new Date().toISOString(),
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
      }
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
      const saved = upsertOrder(payload);
      const matched = findOrderByPayload(payload) || saved;
      const delivered = matched.status === 'delivered';
      const paid = ['paid', 'delivered'].includes(matched.status);

      return sendJson(res, 200, {
        paid,
        delivered,
        status: matched.status,
        account: delivered ? matched.account : '',
        password: delivered ? matched.password : '',
        note: delivered ? matched.deliveredNote : '',
        emailSent: Boolean(matched.emailSentAt),
        deliveredTo: matched.buyerEmail || '',
        emailStatus: matched.emailDeliveryStatus || (matched.emailSentAt ? 'sent' : ''),
        paymentConfig: PAYMENT_CONFIG,
        warning: 'Backend này chỉ gửi email sau khi shop đánh dấu delivered. Muốn tự đối soát giao dịch ngân hàng thật, bạn vẫn cần tích hợp nguồn sao kê hoặc webhook riêng.'
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
      const code = String(error.message || error);
      return sendJson(res, 400, { error: code });
    }
  }

  return sendJson(res, 404, { error: 'NOT_FOUND' });
});

server.listen(PORT, () => {
  console.log(`Hydra backend đang chạy tại http://localhost:${PORT}`);
  console.log(`Tài khoản nhận tiền: ${PAYMENT_CONFIG.bankName} - ${PAYMENT_CONFIG.accountNo}`);
  console.log(`Gửi Gmail: ${mailReady() ? 'ĐÃ BẬT' : 'CHƯA CẤU HÌNH'}`);
  if (!nodemailer) {
    console.log('Thiếu package nodemailer. Chạy: npm install nodemailer');
  }
});
