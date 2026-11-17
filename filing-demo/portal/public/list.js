async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'content-type': 'application/json' }, ...opts });
  if (res.status === 401) {
    location.href = '/login?next=' + encodeURIComponent(location.pathname);
    throw new Error('UNAUTHORIZED');
  }
  return res;
}

async function loadChaos() {
  const res = await fetch('/api/chaos');
  const body = await res.json();
  document.getElementById('chaos-state').textContent = JSON.stringify(body, null, 2);
}

async function putChaos(patch) {
  const cur = await (await fetch('/api/chaos')).json();
  const next = {
    dropSubmitForRecords: cur.dropSubmitForRecords,
    failDraftSaveForRecords: cur.failDraftSaveForRecords,
    ...patch,
  };
  await fetch('/api/chaos', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(next) });
  await loadChaos();
}

(async function init() {
  const me = await (await api('/api/me')).json();
  document.getElementById('who').textContent = `${me.displayName} · ${me.orgName}`;
  document.getElementById('logout').addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST' });
    location.href = '/login';
  });

  const { records } = await (await api('/api/records')).json();
  const tbody = document.querySelector('#records-table tbody');
  for (const r of records) {
    const tr = document.createElement('tr');
    const status = r.submitted
      ? '<span class="badge ok">已提交</span>'
      : r.hasDraft
        ? '<span class="badge warn">草稿（未提交）</span>'
        : '<span class="badge">未填写</span>';
    tr.innerHTML = `
      <td>${r.recordId}</td>
      <td>${r.formVersion}</td>
      <td>${r.hasDraft ? `第 ${r.draftRevision} 版 · ${r.draftUpdatedBy}` : '—'}</td>
      <td>${status}</td>
      <td>${r.receiptId || '—'}</td>
      <td><a href="/form?recordId=${encodeURIComponent(r.recordId)}">打开</a></td>`;
    tbody.appendChild(tr);
  }
  if (!records.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="muted">当前组织暂无申报记录</td></tr>';
  }

  await loadChaos();
  document.getElementById('chaos-drop').addEventListener('click', async () => {
    const id = document.getElementById('chaos-record').value.trim();
    if (!id) return;
    const cur = await (await fetch('/api/chaos')).json();
    await putChaos({ dropSubmitForRecords: [...new Set([...cur.dropSubmitForRecords, id])] });
  });
  document.getElementById('chaos-failsave').addEventListener('click', async () => {
    const id = document.getElementById('chaos-record').value.trim();
    if (!id) return;
    const cur = await (await fetch('/api/chaos')).json();
    await putChaos({ failDraftSaveForRecords: [...new Set([...cur.failDraftSaveForRecords, id])] });
  });
  document.getElementById('chaos-clear').addEventListener('click', async () => {
    await putChaos({ dropSubmitForRecords: [], failDraftSaveForRecords: [] });
  });
})();
