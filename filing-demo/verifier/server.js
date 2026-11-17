import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../shared/env.js';
import { Store } from '../shared/store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
loadEnv(ROOT);

const PORT = Number(process.env.VERIFIER_PORT || 4102);
const PORTAL_URL = process.env.PORTAL_URL || 'http://127.0.0.1:4101';
const SERVICE_TOKEN = process.env.SERVICE_TOKEN || 'demo-service-token';
const DATA_FILE = process.env.VERIFIER_DATA || path.join(ROOT, 'data', 'verifier-store.json');

// 独立核对服务：不信任自动填写程序的自报，收到回执后独立回查门户确认
const store = new Store(DATA_FILE, () => ({ reports: {}, receipts: {}, verifications: {} }));

const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'independent-verifier' }));

// 自动填写程序上报：决策、字段差异、待核验事项
app.post('/api/report', (req, res) => {
  const body = req.body || {};
  if (!body.recordId) return res.status(400).json({ error: 'MISSING_RECORD_ID' });
  store.d.reports[body.recordId] = { ...body, receivedAt: new Date().toISOString() };
  store.save();
  res.json({ ok: true });
});

// 自动填写程序上交门户回执 → 核对服务独立回查门户
app.post('/api/receipts', async (req, res) => {
  const { recordId, receipt, runId } = req.body || {};
  if (!recordId || !receipt) return res.status(400).json({ error: 'MISSING_FIELDS' });
  store.d.receipts[recordId] = { receipt, runId, receivedAt: new Date().toISOString() };
  const verification = await verifyAgainstPortal(recordId, receipt);
  store.d.verifications[recordId] = { ...verification, checkedAt: new Date().toISOString() };
  store.save();
  res.json({ ok: true, verification: store.d.verifications[recordId] });
});

// 手动触发重新核验（看板按钮）
app.post('/api/reverify/:recordId', async (req, res) => {
  const entry = store.d.receipts[req.params.recordId];
  if (!entry) return res.status(404).json({ error: 'NO_RECEIPT' });
  const verification = await verifyAgainstPortal(req.params.recordId, entry.receipt);
  store.d.verifications[req.params.recordId] = { ...verification, checkedAt: new Date().toISOString() };
  store.save();
  res.json({ ok: true, verification: store.d.verifications[req.params.recordId] });
});

async function verifyAgainstPortal(recordId, receipt) {
  let rec;
  try {
    const res = await fetch(`${PORTAL_URL}/api/service/records/${encodeURIComponent(recordId)}`, {
      headers: { authorization: `Bearer ${SERVICE_TOKEN}` },
    });
    if (!res.ok) {
      return { status: 'MISMATCH', reasons: [`门户查询返回 ${res.status}`] };
    }
    rec = await res.json();
  } catch (e) {
    // 门户暂时不可达 → 待核验，而不是误判为不符
    return { status: 'PENDING', reasons: [`暂时无法连接门户：${e.message}`] };
  }
  const reasons = [];
  if (!rec.submission) {
    reasons.push('门户侧无提交记录');
  } else {
    const r = rec.submission.receipt || {};
    if (r.receiptId !== receipt.receiptId) reasons.push(`回执编号不一致（门户 ${r.receiptId || '无'} / 上报 ${receipt.receiptId}）`);
    if (rec.submission.contentHash !== receipt.contentHash) reasons.push('内容指纹不一致');
    if (rec.orgId !== receipt.orgId) reasons.push(`组织归属不一致（门户 ${rec.orgId} / 回执 ${receipt.orgId}）`);
  }
  return reasons.length ? { status: 'MISMATCH', reasons } : { status: 'VERIFIED', reasons: [] };
}

// 看板数据：合并自动程序上报 + 回执 + 核验结论，并汇总“待核验事项”
app.get('/api/dashboard-data', (req, res) => {
  const ids = new Set([...Object.keys(store.d.reports), ...Object.keys(store.d.receipts)]);
  const items = [...ids].map((id) => {
    const report = store.d.reports[id] || null;
    const receiptEntry = store.d.receipts[id] || null;
    const verification = store.d.verifications[id] || null;
    const pendingChecks = [];
    for (const inc of report?.incidents || []) {
      if (!inc.resolved) pendingChecks.push({ type: inc.type, message: inc.message });
    }
    if (receiptEntry && !verification) {
      pendingChecks.push({ type: 'VERIFICATION_MISSING', message: '已收到回执但尚未完成核验' });
    }
    if (verification && verification.status !== 'VERIFIED') {
      pendingChecks.push({
        type: `VERIFICATION_${verification.status}`,
        message: verification.reasons.join('；') || '回执核验未通过',
      });
    }
    return {
      recordId: id,
      report,
      receipt: receiptEntry?.receipt || null,
      verification,
      pendingChecks,
    };
  });
  items.sort((a, b) => a.recordId.localeCompare(b.recordId));
  res.json({ generatedAt: new Date().toISOString(), items });
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`[verifier] 独立核对服务已启动: http://127.0.0.1:${PORT} （结果看板在此）`);
});
