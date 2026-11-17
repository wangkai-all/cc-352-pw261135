import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../shared/env.js';
import { FORM_VERSIONS, fieldKeys } from '../shared/form-versions.js';
import { contentHash } from '../shared/crypto.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
loadEnv(ROOT);

const PORTAL_URL = process.env.PORTAL_URL || 'http://127.0.0.1:4101';
const VERIFIER_URL = process.env.VERIFIER_URL || 'http://127.0.0.1:4102';
const HEADLESS = (process.env.HEADLESS || 'true') !== 'false';
const SUBMIT_TIMEOUT = Number(process.env.SUBMIT_TIMEOUT_MS || 8000);

const argv = process.argv.slice(2);
function argOf(name, dflt) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
}
const ACCOUNT = argOf('account', 'alpha');
const ONLY = argOf('records', null)?.split(',').filter(Boolean) || null;
const RUN_ID = argOf('run-id', `run-${Date.now()}`);

const pending = JSON.parse(fs.readFileSync(path.join(__dirname, 'pending-data.json'), 'utf8'));
const accounts = JSON.parse(fs.readFileSync(path.join(__dirname, 'accounts.json'), 'utf8'));
const creds = accounts[ACCOUNT];
if (!creds) {
  console.error(`未知账号: ${ACCOUNT}（可选：${Object.keys(accounts).join(', ')}）`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.ok;
}

async function fetchMe(ctx) {
  try {
    const res = await ctx.request.get(`${PORTAL_URL}/api/me`);
    return res.ok() ? await res.json() : null;
  } catch {
    return null;
  }
}

async function getRecord(ctx, recordId) {
  try {
    const res = await ctx.request.get(`${PORTAL_URL}/api/records/${encodeURIComponent(recordId)}`);
    return res.ok() ? await res.json() : null;
  } catch {
    return null;
  }
}

function computeDiffs(rec, draftFields) {
  const diffs = [];
  for (const f of FORM_VERSIONS[rec.formVersion].fields) {
    const want = String(rec.fields[f.key] ?? '');
    const have = String(draftFields?.[f.key] ?? '');
    if (want !== have) {
      diffs.push({ field: f.key, label: f.label, pendingValue: want, draftValue: have, action: 'fill' });
    }
  }
  return diffs;
}

async function fillField(page, version, key, value) {
  const def = FORM_VERSIONS[version].fields.find((f) => f.key === key);
  const sel = `[data-field="${key}"]`;
  await page.waitForSelector(sel, { timeout: 5000 });
  if (def.type === 'select') {
    await page.selectOption(sel, String(value));
  } else {
    await page.fill(sel, String(value));
  }
}

async function login(page, creds) {
  await page.goto(`${PORTAL_URL}/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('[data-field="username"]', creds.username);
  await page.fill('[data-field="password"]', creds.password);
  await page.click('#login-btn');
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 5000 }).catch(() => {});
}

// ---------------------------------------------------------------------------
// 提交（含“响应丢失”恢复：先查门户状态，绝不无脑重复提交）
// ---------------------------------------------------------------------------
async function waitSubmitOutcome(page) {
  const kind = await Promise.race([
    page.waitForSelector('#receipt-panel:not([hidden])', { timeout: SUBMIT_TIMEOUT }).then(() => 'receipt'),
    page.waitForSelector('#submit-unknown:not([hidden])', { timeout: SUBMIT_TIMEOUT }).then(() => 'unknown'),
    page.waitForSelector('#submit-conflict:not([hidden])', { timeout: SUBMIT_TIMEOUT }).then(() => 'conflict'),
  ]).catch(() => 'timeout');
  if (kind === 'receipt') {
    const json = await page.locator('#receipt-json').textContent();
    return { kind: 'receipt', receipt: JSON.parse(json) };
  }
  return { kind: kind === 'timeout' ? 'unknown' : kind };
}

async function submitWithRecovery(page, ctx, rec, idemKey, expectedHash, report) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    await page.waitForSelector('#submit-btn:not([disabled])', { timeout: SUBMIT_TIMEOUT });
    await page.click('#submit-btn');
    const outcome = await waitSubmitOutcome(page);

    if (outcome.kind === 'receipt') {
      if (outcome.receipt.contentHash !== expectedHash) {
        report.incidents.push({
          type: 'SUBMITTED_CONTENT_DIFFERS',
          message: '门户返回的既有回执内容指纹与本批待报数据不一致，需人工核对',
        });
      }
      return { receipt: outcome.receipt };
    }

    if (outcome.kind === 'conflict') {
      const st = await getRecord(ctx, rec.recordId);
      if (st?.submission) {
        if (st.submission.contentHash === expectedHash) {
          report.incidents.push({
            type: 'ALREADY_SUBMITTED_RECOVERED',
            resolved: true,
            message: '提交冲突：门户已受理且内容一致，采用既有回执，未重复提交',
          });
          return { receipt: st.submission.receipt };
        }
        report.incidents.push({
          type: 'SUBMITTED_CONTENT_DIFFERS',
          message: '提交冲突：门户已受理的内容与本批数据不一致，需人工核对',
        });
      } else {
        report.incidents.push({
          type: 'REVISION_CONFLICT',
          message: '草稿在提交前被并发修改（版本冲突），需人工核验',
        });
      }
      return { receipt: null };
    }

    // outcome.kind === 'unknown'：响应可能丢失。先查状态，再决定重试或恢复。
    const st = await getRecord(ctx, rec.recordId);
    if (st?.submission) {
      if (st.submission.idempotencyKey === idemKey || st.submission.contentHash === expectedHash) {
        report.incidents.push({
          type: 'SUBMIT_RESPONSE_LOST',
          resolved: true,
          message: '提交响应丢失，经状态查询确认门户已受理，恢复回执且未重复提交',
        });
        return { receipt: st.submission.receipt };
      }
      report.incidents.push({
        type: 'SUBMIT_STATE_AMBIGUOUS',
        message: '提交结果不明，且门户已存在非本程序的提交，需人工核对',
      });
      return { receipt: null };
    }
    report.incidents.push({
      type: 'SUBMIT_RESPONSE_LOST',
      resolved: true,
      message: `第 ${attempt} 次提交响应丢失，门户确认未受理，使用同一幂等键重试`,
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#decl-form [data-field]', { timeout: SUBMIT_TIMEOUT });
    // 重载后页面上下文丢失，恢复同一幂等键再重试
    await page.evaluate((k) => { window.__clientKey = k; }, idemKey);
  }
  report.incidents.push({ type: 'SUBMIT_FAILED', message: '多次提交均未获得回执，转人工处理' });
  return { receipt: null };
}

// ---------------------------------------------------------------------------
// 单条记录处理
// ---------------------------------------------------------------------------
async function processRecord(ctx, rec) {
  const report = {
    runId: RUN_ID,
    recordId: rec.recordId,
    orgId: rec.orgId,
    formVersion: rec.formVersion,
    account: ACCOUNT,
    decision: '未执行',
    diffs: [],
    incidents: [],
    receipt: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  const page = await ctx.newPage();
  try {
    // 1) 确认浏览器身份：未登录或账号被换掉时，先重新登录，再继续
    let me = await fetchMe(ctx);
    if (!me || me.username !== creds.username) {
      if (me) {
        report.incidents.push({
          type: 'ACCOUNT_SWITCHED',
          resolved: true,
          message: `浏览器当前账号 ${me.username} 与预期 ${creds.username} 不一致，已重新登录`,
        });
      }
      const page0 = await ctx.newPage();
      await login(page0, creds);
      await page0.close();
      me = await fetchMe(ctx);
      if (!me || me.username !== creds.username) {
        report.incidents.push({ type: 'AUTH_FAILED', message: '登录失败，终止该条处理' });
        report.decision = '终止（登录失败）';
        return report;
      }
    }

    // 2) 组织归属校验：归属不符，禁止任何写操作
    if (me.orgId !== rec.orgId) {
      report.incidents.push({
        type: 'ORG_MISMATCH',
        message: `当前账号组织 ${me.orgId} 与待报数据归属 ${rec.orgId} 不一致，禁止提交`,
      });
      report.decision = '终止（组织归属不符）';
      return report;
    }

    // 3) 读取门户侧状态
    const state = await getRecord(ctx, rec.recordId);
    if (!state) {
      report.incidents.push({ type: 'RECORD_NOT_FOUND', message: '门户查无此记录或无权访问' });
      report.decision = '终止（记录不存在）';
      return report;
    }
    if (state.formVersion !== rec.formVersion) {
      report.incidents.push({
        type: 'VERSION_MISMATCH',
        message: `门户表单版本 ${state.formVersion} 与待报数据版本 ${rec.formVersion} 不一致，需人工确认`,
      });
      report.decision = '终止（表单版本不一致）';
      return report;
    }

    const keys = fieldKeys(rec.formVersion);
    const expectedHash = contentHash(rec.fields, keys);
    const idemKey = `decl-${rec.recordId}-${expectedHash.slice(0, 12)}`;

    // 4) 已提交 → 直接取回执（恢复场景），不重复提交
    if (state.submission) {
      report.decision = '无需提交（门户已受理）';
      report.receipt = state.submission.receipt;
      if (state.submission.contentHash !== expectedHash) {
        report.incidents.push({
          type: 'SUBMITTED_CONTENT_DIFFERS',
          message: '门户已提交内容与本批待报数据不一致，需人工核对',
        });
      }
      return report;
    }

    // 5) 草稿比对 → 在“整单重填”与“字段级续填”之间决策
    const draft = state.draft;
    const diffs = computeDiffs(rec, draft?.fields);
    report.diffs = diffs;
    let fieldsToFill = [];
    if (!draft || Object.keys(draft.fields || {}).length === 0) {
      report.decision = '整单重填（无可用草稿）';
      fieldsToFill = [...keys];
    } else if (diffs.length === 0) {
      report.decision = '草稿一致，直接提交';
    } else if (draft.updatedBy !== creds.username) {
      report.decision = '终止（草稿被他人修改，待人工核验）';
      report.incidents.push({
        type: 'DRAFT_MODIFIED_BY_OTHER',
        message: `草稿最近由 ${draft.updatedBy} 修改，与待报数据存在 ${diffs.length} 处差异；不覆盖、不提交`,
      });
      return report;
    } else {
      report.decision = `字段级续填（${diffs.length} 个差异字段）`;
      fieldsToFill = diffs.map((d) => d.field);
    }

    // 6) 打开表单页，按需回填
    await page.goto(`${PORTAL_URL}/form?recordId=${encodeURIComponent(rec.recordId)}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#decl-form [data-field]', { timeout: SUBMIT_TIMEOUT });
    await page.evaluate((k) => { window.__clientKey = k; }, idemKey);

    if (fieldsToFill.length) {
      for (const key of fieldsToFill) await fillField(page, rec.formVersion, key, rec.fields[key]);
      let saveRes = await page.evaluate(() => window.__saveNow());
      if (!saveRes?.ok) {
        await page.waitForTimeout(1000);
        saveRes = await page.evaluate(() => window.__saveNow());
      }
      if (!saveRes?.ok) {
        report.incidents.push({ type: 'DRAFT_SAVE_FAILED', message: `草稿保存失败：${saveRes?.error || '未知错误'}` });
        report.decision = '终止（草稿保存失败）';
        return report;
      }
      if (saveRes.draftHash !== expectedHash) {
        report.incidents.push({
          type: 'DRAFT_HASH_MISMATCH',
          message: '保存后草稿内容指纹与待报数据不一致，禁止提交',
        });
        report.decision = '终止（草稿内容不符）';
        return report;
      }
    }

    // 7) 正式提交（独立动作），响应丢失时按状态恢复
    const { receipt } = await submitWithRecovery(page, ctx, rec, idemKey, expectedHash, report);
    if (receipt) report.receipt = receipt;
    return report;
  } catch (e) {
    report.incidents.push({ type: 'AUTOMATION_ERROR', message: String(e?.message || e) });
    report.decision = '终止（程序异常）';
    return report;
  } finally {
    report.finishedAt = new Date().toISOString();
    await page.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
const profileDir = path.join(ROOT, 'data', 'profiles', ACCOUNT);
// 无 root 环境下解包到 data/browser-libs 的系统库（见 scripts/install-browser-libs.sh）
const libsDir = path.join(ROOT, 'data', 'browser-libs');
const libPath = fs.existsSync(libsDir)
  ? [path.join(libsDir, 'lib', 'x86_64-linux-gnu'), path.join(libsDir, 'usr', 'lib', 'x86_64-linux-gnu')]
      .filter((p) => fs.existsSync(p))
      .join(':')
  : null;
// 容器内没有系统 fontconfig：为浏览器生成一份本地字体配置
let browserEnv = { ...process.env };
if (libPath) {
  const fontsConf = path.join(libsDir, 'fonts.conf');
  fs.writeFileSync(
    fontsConf,
    `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>${path.join(libsDir, 'usr', 'share', 'fonts')}</dir>
  <cachedir>${path.join(libsDir, 'fontconfig-cache')}</cachedir>
</fontconfig>
`,
  );
  browserEnv = {
    ...browserEnv,
    LD_LIBRARY_PATH: `${libPath}${process.env.LD_LIBRARY_PATH ? ':' + process.env.LD_LIBRARY_PATH : ''}`,
    FONTCONFIG_FILE: fontsConf,
  };
}
const ctx = await chromium.launchPersistentContext(profileDir, {
  headless: HEADLESS,
  viewport: { width: 1280, height: 900 },
  env: browserEnv,
});

const results = [];
try {
  for (const rec of pending.records) {
    if (ONLY && !ONLY.includes(rec.recordId)) continue;
    console.log(`\n[${RUN_ID}] 处理 ${rec.recordId}（${rec.formVersion} / ${rec.orgId}）…`);
    const report = await processRecord(ctx, rec);
    results.push(report);
    console.log(`  决策: ${report.decision}`);
    for (const inc of report.incidents) console.log(`  事项: [${inc.type}] ${inc.message}`);
    if (report.receipt) console.log(`  回执: ${report.receipt.receiptId}`);

    await postJson(`${VERIFIER_URL}/api/report`, report).catch(() => console.warn('  警告：上报核对服务失败（report）'));
    if (report.receipt) {
      await postJson(`${VERIFIER_URL}/api/receipts`, { runId: RUN_ID, recordId: rec.recordId, receipt: report.receipt })
        .catch(() => console.warn('  警告：上报核对服务失败（receipt）'));
    }
  }
} finally {
  await ctx.close();
}

const runsDir = path.join(ROOT, 'data', 'runs');
fs.mkdirSync(runsDir, { recursive: true });
fs.writeFileSync(path.join(runsDir, `${RUN_ID}.json`), JSON.stringify(results, null, 2));

const done = results.filter((r) => r.receipt).length;
const blocked = results.filter((r) => r.incidents.some((i) => !i.resolved)).length;
console.log(`\n完成：${results.length} 条处理，${done} 条获得回执，${blocked} 条含待核验事项。`);
console.log(`结果看板: ${VERIFIER_URL}`);
