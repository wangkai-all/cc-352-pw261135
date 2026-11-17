import express from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../shared/env.js';
import { Store } from '../shared/store.js';
import { FORM_VERSIONS, formDef, fieldKeys } from '../shared/form-versions.js';
import { contentHash } from '../shared/crypto.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
loadEnv(ROOT);

const PORT = Number(process.env.PORTAL_PORT || 4101);
const SERVICE_TOKEN = process.env.SERVICE_TOKEN || 'demo-service-token';
const DATA_FILE = process.env.PORTAL_DATA || path.join(ROOT, 'data', 'portal-store.json');

// ---------------------------------------------------------------------------
// 初始数据：全部为虚构账号，仅用于演示
// ---------------------------------------------------------------------------
function defaultPortalData() {
  return {
    accounts: [
      { username: 'alpha', password: 'demo1234', orgId: 'ORG-ALPHA', orgName: '阿尔法示例制造有限公司（虚构）', displayName: '阿尔法填报员' },
      { username: 'alpha2', password: 'demo1234', orgId: 'ORG-ALPHA', orgName: '阿尔法示例制造有限公司（虚构）', displayName: '阿尔法财务主管' },
      { username: 'beta', password: 'demo1234', orgId: 'ORG-BETA', orgName: '贝塔示例贸易有限公司（虚构）', displayName: '贝塔填报员' },
    ],
    sessions: {},
    records: {},
    receipts: {},
    counters: { receipt: 1000 },
  };
}

const store = new Store(DATA_FILE, defaultPortalData);

// 故障注入开关（仅内存，重启即失效）：演示“提交后响应丢失”“草稿保存失败”等故障
const chaos = {
  dropSubmitForRecords: new Set(),
  failDraftSaveForRecords: new Set(),
};

const app = express();
app.use(express.json({ limit: '1mb' }));

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function currentAccount(req) {
  const sid = parseCookies(req).sid;
  const session = sid ? store.d.sessions[sid] : null;
  if (!session) return null;
  return store.d.accounts.find((a) => a.username === session.username) || null;
}

function requireAuth(req, res) {
  const acct = currentAccount(req);
  if (!acct) {
    res.status(401).json({ error: 'UNAUTHORIZED' });
    return null;
  }
  return acct;
}

function findRecord(req, res, acct) {
  const rec = store.d.records[req.params.id];
  if (!rec) {
    res.status(404).json({ error: 'NOT_FOUND' });
    return null;
  }
  if (acct && rec.orgId !== acct.orgId) {
    res.status(403).json({ error: 'FORBIDDEN_ORG', message: '该记录不属于当前登录组织' });
    return null;
  }
  return rec;
}

// ---------------------------------------------------------------------------
// 页面
// ---------------------------------------------------------------------------
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'list.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/form', (req, res) => res.sendFile(path.join(__dirname, 'public', 'form.html')));
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// 账号
// ---------------------------------------------------------------------------
app.get('/api/health', (req, res) => res.json({ ok: true, service: 'fictional-portal' }));

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const acct = store.d.accounts.find((a) => a.username === username && a.password === password);
  if (!acct) return res.status(401).json({ error: 'BAD_CREDENTIALS' });
  const sid = crypto.randomUUID();
  store.d.sessions[sid] = { username: acct.username, createdAt: new Date().toISOString() };
  store.save();
  res.setHeader('Set-Cookie', `sid=${sid}; Path=/; HttpOnly; SameSite=Lax`);
  res.json({ ok: true, username: acct.username, orgId: acct.orgId, orgName: acct.orgName });
});

app.post('/api/logout', (req, res) => {
  const sid = parseCookies(req).sid;
  if (sid && store.d.sessions[sid]) {
    delete store.d.sessions[sid];
    store.save();
  }
  res.setHeader('Set-Cookie', 'sid=; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const acct = currentAccount(req);
  if (!acct) return res.status(401).json({ error: 'UNAUTHORIZED' });
  res.json({ username: acct.username, orgId: acct.orgId, orgName: acct.orgName, displayName: acct.displayName });
});

app.get('/api/form-versions', (req, res) => res.json(FORM_VERSIONS));

// ---------------------------------------------------------------------------
// 申报记录：草稿自动保存 与 正式提交 是两个独立动作
// ---------------------------------------------------------------------------
app.get('/api/records', (req, res) => {
  const acct = requireAuth(req, res);
  if (!acct) return;
  const records = Object.values(store.d.records)
    .filter((r) => r.orgId === acct.orgId)
    .map((r) => ({
      recordId: r.recordId,
      formVersion: r.formVersion,
      hasDraft: !!r.draft,
      draftRevision: r.draft?.revision || 0,
      draftUpdatedBy: r.draft?.updatedBy || null,
      submitted: !!r.submission,
      receiptId: r.submission?.receipt?.receiptId || null,
    }))
    .sort((a, b) => a.recordId.localeCompare(b.recordId));
  res.json({ records });
});

app.get('/api/records/:id', (req, res) => {
  const acct = requireAuth(req, res);
  if (!acct) return;
  const rec = findRecord(req, res, acct);
  if (!rec) return;
  res.json(rec);
});

// 自动保存草稿：允许部分字段；保存草稿 ≠ 完成申报
app.put('/api/records/:id/draft', (req, res) => {
  const acct = requireAuth(req, res);
  if (!acct) return;
  const rec = findRecord(req, res, acct);
  if (!rec) return;
  if (rec.submission) return res.status(409).json({ error: 'ALREADY_SUBMITTED' });
  if (chaos.failDraftSaveForRecords.has(rec.recordId)) {
    return res.status(500).json({ error: 'CHAOS_SAVE_FAIL', message: '故障注入：草稿保存失败' });
  }
  const { fields = {}, clientKey = null } = req.body || {};
  const clean = {};
  for (const k of fieldKeys(rec.formVersion)) {
    if (fields[k] !== undefined) clean[k] = String(fields[k]);
  }
  const revision = (rec.draft?.revision || 0) + 1;
  rec.draft = {
    fields: clean,
    revision,
    clientKey,
    updatedBy: acct.username,
    savedAt: new Date().toISOString(),
    draftHash: contentHash(clean, fieldKeys(rec.formVersion)),
  };
  store.save();
  res.json({
    ok: true,
    revision,
    draftHash: rec.draft.draftHash,
    savedAt: rec.draft.savedAt,
    submitted: false,
    notice: '草稿已保存；保存草稿不等于完成申报',
  });
});

// 正式提交：独立动作；幂等；带乐观并发与故障注入
app.post('/api/records/:id/submit', (req, res) => {
  const acct = requireAuth(req, res);
  if (!acct) return;
  const rec = findRecord(req, res, acct);
  if (!rec) return;
  const { baseRevision, idempotencyKey = null } = req.body || {};

  // 故障注入：持续丢弃该记录的提交响应（模拟“提交后响应丢失”）。
  // 放在幂等处理之前：浏览器传输层会自动重发被掐断的请求，重发的一并丢弃，
  // 这样客户端才会真正面对“结果未知”。提交本身已在下方生效过一次。
  if (chaos.dropSubmitForRecords.has(rec.recordId)) {
    if (!rec.submission) {
      // 首个到达的请求正常走完受理逻辑，只是不回响应
      return processSubmit(req, res, rec, acct, { baseRevision, idempotencyKey }, /* dropResponse */ true);
    }
    console.log(`[chaos] 丢弃提交响应（重发）: ${rec.recordId}`);
    req.socket.destroy();
    return;
  }
  return processSubmit(req, res, rec, acct, { baseRevision, idempotencyKey }, false);
});

function processSubmit(req, res, rec, acct, { baseRevision, idempotencyKey }, dropResponse) {

  // 幂等：同一幂等键重复提交 → 返回原回执；不同键 → 409 并附既有回执
  if (rec.submission) {
    if (idempotencyKey && idempotencyKey === rec.submission.idempotencyKey) {
      return res.json({ ok: true, receipt: rec.submission.receipt, already: true });
    }
    return res.status(409).json({ error: 'ALREADY_SUBMITTED', receipt: rec.submission.receipt });
  }
  if (!rec.draft) return res.status(409).json({ error: 'NO_DRAFT', message: '没有可提交的草稿' });
  if (typeof baseRevision === 'number' && baseRevision !== rec.draft.revision) {
    return res.status(409).json({
      error: 'REVISION_CONFLICT',
      currentRevision: rec.draft.revision,
      updatedBy: rec.draft.updatedBy,
      message: '草稿在提交前被他人修改',
    });
  }
  const def = formDef(rec.formVersion);
  const missing = def.fields
    .filter((f) => f.required && !String(rec.draft.fields[f.key] ?? '').trim())
    .map((f) => f.key);
  if (missing.length) return res.status(422).json({ error: 'MISSING_REQUIRED', missing });

  const receipt = {
    receiptId: `RCPT-${String(++store.d.counters.receipt).padStart(6, '0')}`,
    recordId: rec.recordId,
    orgId: rec.orgId,
    formVersion: rec.formVersion,
    contentHash: rec.draft.draftHash,
    idempotencyKey: idempotencyKey || rec.draft.clientKey || null,
    submittedAt: new Date().toISOString(),
    submittedBy: acct.username,
    status: 'ACCEPTED',
    note: '虚构门户演示回执，无法律效力',
  };
  rec.submission = {
    receipt,
    idempotencyKey: receipt.idempotencyKey,
    contentHash: receipt.contentHash,
    submittedAt: receipt.submittedAt,
    submittedBy: acct.username,
  };
  store.d.receipts[receipt.receiptId] = receipt;
  store.save();

  // 故障注入：提交已在服务端生效，但响应“丢失”（连接被掐断）
  if (dropResponse) {
    console.log(`[chaos] 提交已生效但丢弃响应: ${rec.recordId} -> ${receipt.receiptId}`);
    req.socket.destroy();
    return;
  }
  res.json({ ok: true, receipt });
}

// ---------------------------------------------------------------------------
// 服务间只读接口：供独立核对服务核验回执（不经过浏览器会话）
// ---------------------------------------------------------------------------
app.get('/api/service/records/:id', (req, res) => {
  if (req.headers.authorization !== `Bearer ${SERVICE_TOKEN}`) {
    return res.status(401).json({ error: 'UNAUTHORIZED' });
  }
  const rec = store.d.records[req.params.id];
  if (!rec) return res.status(404).json({ error: 'NOT_FOUND' });
  res.json(rec);
});

// ---------------------------------------------------------------------------
// 故障注入与演示管理接口（仅限本机演示，无真实业务语义）
// ---------------------------------------------------------------------------
app.get('/api/chaos', (req, res) => {
  res.json({
    dropSubmitForRecords: [...chaos.dropSubmitForRecords],
    failDraftSaveForRecords: [...chaos.failDraftSaveForRecords],
  });
});

app.put('/api/chaos', (req, res) => {
  const b = req.body || {};
  chaos.dropSubmitForRecords = new Set(b.dropSubmitForRecords || []);
  chaos.failDraftSaveForRecords = new Set(b.failDraftSaveForRecords || []);
  res.json({ ok: true, ...JSON.parse(JSON.stringify({ dropSubmitForRecords: [...chaos.dropSubmitForRecords], failDraftSaveForRecords: [...chaos.failDraftSaveForRecords] })) });
});

app.post('/api/admin/reset', (req, res) => {
  const records = {};
  for (const r of req.body?.records || []) {
    records[r.recordId] = {
      recordId: r.recordId,
      orgId: r.orgId,
      formVersion: r.formVersion,
      draft: null,
      submission: null,
    };
  }
  store.reset({ ...defaultPortalData(), records });
  chaos.dropSubmitForRecords.clear();
  chaos.failDraftSaveForRecords.clear();
  res.json({ ok: true, records: Object.keys(records) });
});

// 以指定用户身份预置草稿：用于构造“草稿被他人修改”“续填自己的草稿”等场景
app.post('/api/admin/seed-draft', (req, res) => {
  const { recordId, fields = {}, asUser } = req.body || {};
  const rec = store.d.records[recordId];
  if (!rec) return res.status(404).json({ error: 'NOT_FOUND' });
  if (rec.submission) return res.status(409).json({ error: 'ALREADY_SUBMITTED' });
  const clean = {};
  for (const k of fieldKeys(rec.formVersion)) {
    if (fields[k] !== undefined) clean[k] = String(fields[k]);
  }
  const revision = (rec.draft?.revision || 0) + 1;
  rec.draft = {
    fields: clean,
    revision,
    clientKey: `seed-${asUser}`,
    updatedBy: asUser,
    savedAt: new Date().toISOString(),
    draftHash: contentHash(clean, fieldKeys(rec.formVersion)),
  };
  store.save();
  res.json({ ok: true, revision, draftHash: rec.draft.draftHash });
});

app.listen(PORT, () => {
  console.log(`[portal] 虚构填报门户已启动: http://127.0.0.1:${PORT} （演示账号 alpha / beta，密码 demo1234）`);
});
