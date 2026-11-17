/* 虚构填报门户前端：自动保存草稿 + 显式正式提交。
 * 关键约定：
 *  - 草稿改动后 800ms 自动保存（仅暂存，不等于申报完成）；
 *  - 「正式提交」是独立动作，携带草稿版本号做并发校验、携带幂等键防重复；
 *  - 提交请求网络失败时只提示“结果未知”，绝不自动重试，交由人工或自动程序核对状态。
 */
const qs = new URLSearchParams(location.search);
const recordId = qs.get('recordId');

const $ = (s) => document.querySelector(s);
let me = null;
let record = null;
let formDef = null;
let lastRevision = 0;
let dirty = false;
let saveTimer = null;
let saveChain = Promise.resolve({ ok: true, skipped: true });

function defaultClientKey() {
  return `manual-${me?.username || 'anon'}-${recordId}`;
}
function clientKey() {
  return window.__clientKey || defaultClientKey();
}

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'content-type': 'application/json' }, ...opts });
  if (res.status === 401) {
    location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search);
    throw new Error('UNAUTHORIZED');
  }
  return res;
}

function setSaveState(state, text) {
  const el = $('#save-status');
  el.dataset.state = state;
  el.textContent = text;
}

function updateSubmitBtn() {
  // 注意：不能因 dirty 禁用按钮——点击提交触发的 blur/change 会把按钮在点击途中禁用，
  // 导致 click 事件被浏览器吞掉。提交前是否已保存由 submit() 内部的 save() 兜底。
  $('#submit-btn').disabled = !record || !!record.submission;
}

function collect() {
  const out = {};
  for (const f of formDef.fields) {
    const el = document.querySelector(`[data-field="${f.key}"]`);
    out[f.key] = el ? el.value : '';
  }
  return out;
}

function renderForm() {
  $('#form-title').textContent = formDef.title;
  $('#record-meta').textContent = `记录编号 ${record.recordId} · 表单版本 ${record.formVersion} · 归属 ${me.orgName}`;
  const form = $('#decl-form');
  form.innerHTML = '';
  const draftFields = record.draft?.fields || {};
  for (const f of formDef.fields) {
    const label = document.createElement('label');
    label.textContent = f.label + (f.required ? ' *' : '');
    let input;
    if (f.type === 'select') {
      input = document.createElement('select');
      const empty = document.createElement('option');
      empty.value = '';
      empty.textContent = '（请选择）';
      input.appendChild(empty);
      for (const opt of f.options) {
        const o = document.createElement('option');
        o.value = opt;
        o.textContent = opt;
        input.appendChild(o);
      }
    } else {
      input = document.createElement('input');
      input.type = 'text';
      if (f.type === 'number') input.inputMode = 'decimal';
    }
    input.dataset.field = f.key;
    input.value = draftFields[f.key] ?? '';
    input.addEventListener('input', onDirty);
    input.addEventListener('change', onDirty);
    label.appendChild(input);
    form.appendChild(label);
  }
  lastRevision = record.draft?.revision || 0;
  if (record.draft) {
    setSaveState('saved', `草稿已保存（第 ${lastRevision} 版，${record.draft.updatedBy}）· 仍未提交`);
  }
}

function onDirty() {
  dirty = true;
  setSaveState('dirty', '有未保存修改…');
  updateSubmitBtn();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 800);
}

async function doSave() {
  if (!dirty) return { ok: true, skipped: true, revision: lastRevision };
  setSaveState('saving', '正在自动保存草稿…');
  try {
    const res = await api(`/api/records/${encodeURIComponent(recordId)}/draft`, {
      method: 'PUT',
      body: JSON.stringify({ fields: collect(), clientKey: clientKey() }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.message || body.error || `HTTP ${res.status}`);
    lastRevision = body.revision;
    dirty = false;
    setSaveState('saved', `草稿已保存（第 ${body.revision} 版）· 保存草稿不等于完成申报`);
    updateSubmitBtn();
    return { ok: true, ...body };
  } catch (e) {
    setSaveState('error', '草稿保存失败：' + e.message);
    return { ok: false, error: e.message };
  }
}

// 串行化保存，避免自动保存与显式保存并发
function save() {
  clearTimeout(saveTimer);
  const p = saveChain.then(doSave);
  saveChain = p.catch(() => ({ ok: false }));
  return p;
}

window.__saveNow = () => save();
window.__getState = () => ({ revision: lastRevision, dirty, fields: collect() });

function showReceipt(receipt, already = false) {
  record.submission = record.submission || { receipt };
  $('#receipt-note').textContent = already
    ? '该记录此前已提交，以下为既有回执（未重复提交）。'
    : '提交成功，申报完成。';
  $('#receipt-json').textContent = JSON.stringify(receipt, null, 2);
  $('#receipt-panel').hidden = false;
  $('#banner-draft').innerHTML = '<strong>该记录已提交。</strong>回执即申报完成凭证。';
  $('#banner-draft').classList.add('ok');
  for (const el of document.querySelectorAll('#decl-form input, #decl-form select')) el.disabled = true;
  updateSubmitBtn();
}

async function submit() {
  $('#submit-unknown').hidden = true;
  $('#submit-conflict').hidden = true;
  const s = await save();
  if (!s.ok || dirty) return; // 草稿未保存成功，不进入提交
  $('#submit-btn').disabled = true;
  let res;
  try {
    res = await api(`/api/records/${encodeURIComponent(recordId)}/submit`, {
      method: 'POST',
      body: JSON.stringify({ baseRevision: lastRevision, idempotencyKey: clientKey() }),
    });
  } catch (e) {
    // 网络层失败：提交可能已生效也可能没有，结果未知
    $('#submit-unknown').hidden = false;
    window.__submitUnknown = true;
    $('#submit-btn').disabled = false;
    return;
  }
  const body = await res.json().catch(() => ({}));
  if (res.ok) {
    showReceipt(body.receipt, !!body.already);
    return;
  }
  if (body.error === 'ALREADY_SUBMITTED' && body.receipt) {
    showReceipt(body.receipt, true);
    return;
  }
  const conflict = $('#submit-conflict');
  if (body.error === 'REVISION_CONFLICT') {
    conflict.textContent = `草稿已被 ${body.updatedBy} 修改（当前第 ${body.currentRevision} 版）。请刷新页面核对差异后再决定是否提交。`;
  } else if (body.error === 'MISSING_REQUIRED') {
    conflict.textContent = `必填字段缺失：${(body.missing || []).join('、')}，请补全后再提交。`;
  } else {
    conflict.textContent = `提交失败：${body.message || body.error || res.status}`;
  }
  conflict.hidden = false;
  $('#submit-btn').disabled = false;
}

$('#submit-btn').addEventListener('click', submit);

(async function init() {
  const meRes = await api('/api/me');
  me = await meRes.json();
  $('#who').textContent = `${me.displayName} · ${me.orgName}`;
  if (!recordId) {
    location.href = '/';
    return;
  }
  const rRes = await api(`/api/records/${encodeURIComponent(recordId)}`);
  if (!rRes.ok) {
    $('#form-title').textContent = '记录不存在或不属于当前组织';
    return;
  }
  record = await rRes.json();
  const versions = await (await api('/api/form-versions')).json();
  formDef = versions[record.formVersion];
  renderForm();
  if (record.submission) showReceipt(record.submission.receipt);
  updateSubmitBtn();
})();
