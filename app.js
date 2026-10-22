const state = {
  turmas: [],
  alunos: [],
  collapsed: new Set(),
  ws: null,
};

const tipoLabels = {
  M: 'Meio periodo',
  I: 'Integral',
  In: 'Intermediario',
};

const el = (id) => document.getElementById(id);

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]));
}

function toast(message) {
  const box = el('toast');
  box.textContent = message;
  box.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => box.classList.remove('show'), 2600);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.erro || `Erro HTTP ${res.status}`);
  return data;
}

async function loadData() {
  const [turmas, alunos] = await Promise.all([api('/api/turmas'), api('/api/alunos')]);
  state.turmas = turmas;
  state.alunos = alunos;
  fillSelects();
  render();
}

function fillSelects() {
  const turmaFilter = el('turmaFilter');
  const selectedFilter = turmaFilter.value;
  turmaFilter.innerHTML = '<option value="">Todas as turmas</option>' +
    state.turmas.map((t) => `<option value="${t.id}">${escapeHtml(t.nome)}</option>`).join('');
  turmaFilter.value = selectedFilter;

  const studentTurma = el('studentTurma');
  const selectedStudent = studentTurma.value;
  studentTurma.innerHTML = state.turmas
    .map((t) => `<option value="${t.id}">${escapeHtml(t.nome)}</option>`)
    .join('');
  if (selectedStudent) studentTurma.value = selectedStudent;
}

function filters() {
  return {
    q: el('searchInput').value.trim().toLowerCase(),
    turmaId: el('turmaFilter').value,
    tipo: el('tipoFilter').value,
  };
}

function filteredAlunos() {
  const f = filters();
  return state.alunos.filter((aluno) => {
    if (f.turmaId && String(aluno.turma_id) !== f.turmaId) return false;
    if (f.tipo && aluno.tipo !== f.tipo) return false;
    if (f.q && !aluno.nome.toLowerCase().includes(f.q)) return false;
    return true;
  });
}

function countByTipo(alunos) {
  return alunos.reduce((acc, aluno) => {
    acc[aluno.tipo] = (acc[aluno.tipo] || 0) + 1;
    return acc;
  }, { M: 0, I: 0, In: 0 });
}

function render() {
  const alunos = filteredAlunos();
  const visibleTurmaIds = new Set(alunos.map((a) => a.turma_id));
  const f = filters();
  const turmas = state.turmas.filter((turma) => (!f.turmaId || String(turma.id) === f.turmaId) && visibleTurmaIds.has(turma.id));

  el('totalTurmas').textContent = turmas.length;
  el('totalAlunos').textContent = alunos.length;
  el('totalProfessoras').textContent = new Set(turmas.map((t) => t.professora).filter(Boolean)).size;
  el('totalAuxiliares').textContent = new Set(turmas.map((t) => t.auxiliar).filter(Boolean)).size;

  const grid = el('turmasGrid');
  if (!turmas.length) {
    grid.innerHTML = '<div class="empty">Nenhum aluno encontrado com os filtros atuais.</div>';
    return;
  }

  grid.innerHTML = turmas.map((turma) => {
    const turmaAlunos = alunos.filter((aluno) => aluno.turma_id === turma.id);
    const counts = countByTipo(turmaAlunos);
    const collapsed = state.collapsed.has(turma.id);
    return `
      <article class="turma-card ${collapsed ? 'collapsed' : ''}" data-turma="${turma.id}">
        <div class="turma-head">
          <div class="turma-top">
            <div>
              <h2 class="turma-title">${escapeHtml(turma.nome)}</h2>
              <div class="team">
                <span>Professora: ${escapeHtml(turma.professora || '-')}</span>
                <span>Auxiliar: ${escapeHtml(turma.auxiliar || '-')}</span>
              </div>
            </div>
            <button class="btn" type="button" data-toggle="${turma.id}">${collapsed ? 'Expandir' : 'Recolher'}</button>
          </div>
          <div class="counts">
            <span class="count-chip tipo-M">M ${counts.M}</span>
            <span class="count-chip tipo-I">I ${counts.I}</span>
            <span class="count-chip tipo-In">In ${counts.In}</span>
          </div>
          <div class="turma-actions">
            <button class="btn" type="button" data-export="${turma.id}">Exportar CSV</button>
            <button class="btn" type="button" data-call-prof="${turma.id}">Chamar professora</button>
            <button class="btn" type="button" data-call-aux="${turma.id}">Chamar auxiliar</button>
          </div>
        </div>
        <div class="alunos-wrap">
          <ul class="alunos">
            ${turmaAlunos.map((aluno) => `
              <li class="aluno">
                <div>
                  <div class="aluno-nome">${escapeHtml(aluno.nome)}</div>
                  <div class="aluno-meta">${escapeHtml(aluno.nascimento || '')}</div>
                  <div class="call-row">
                    <button class="btn" type="button" data-edit="${aluno.id}">Editar</button>
                    <button class="btn" type="button" data-call-student="${aluno.id}">Chamar</button>
                    <button class="btn" type="button" data-delete="${aluno.id}">Excluir</button>
                  </div>
                </div>
                <span class="badge tipo-${aluno.tipo}" title="${tipoLabels[aluno.tipo]}">${aluno.tipo}</span>
              </li>
            `).join('')}
          </ul>
        </div>
      </article>
    `;
  }).join('');
}

async function checkServer() {
  const status = el('serverStatus');
  try {
    const ping = await api('/ping');
    status.classList.add('online');
    status.querySelector('span:last-child').textContent = `Servidor online - ${ping.uptime}s`;
  } catch {
    status.classList.remove('online');
    status.querySelector('span:last-child').textContent = 'Servidor offline';
  }
}

function exportCsv(turmaId) {
  const turma = state.turmas.find((item) => item.id === turmaId);
  const alunos = state.alunos.filter((aluno) => aluno.turma_id === turmaId);
  const rows = [
    ['Turma', 'Professora', 'Auxiliar', 'Aluno', 'Nascimento', 'Tipo'],
    ...alunos.map((a) => [turma.nome, turma.professora, turma.auxiliar, a.nome, a.nascimento || '', a.tipo]),
  ];
  const csv = rows.map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${turma.nome.replaceAll(' ', '_')}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function openStudentModal(aluno) {
  el('studentId').value = aluno?.id || '';
  el('studentName').value = aluno?.nome || '';
  el('studentTurma').value = aluno?.turma_id || state.turmas[0]?.id || '';
  el('studentTipo').value = aluno?.tipo || 'I';
  el('studentNascimento').value = aluno?.nascimento || '';
  el('studentTitle').textContent = aluno ? 'Editar aluno' : 'Novo aluno';
  el('studentModal').classList.add('open');
  el('studentName').focus();
}

function closeModal() {
  el('studentModal').classList.remove('open');
}

async function saveStudent(event) {
  event.preventDefault();
  const id = el('studentId').value;
  const payload = {
    nome: el('studentName').value,
    turma_id: Number(el('studentTurma').value),
    tipo: el('studentTipo').value,
    nascimento: el('studentNascimento').value,
  };
  await api(id ? `/api/alunos/${id}` : '/api/alunos', {
    method: id ? 'PUT' : 'POST',
    body: JSON.stringify(payload),
  });
  closeModal();
  await loadData();
  toast('Aluno salvo.');
}

async function createCall(pessoa, papel, turmaId) {
  await api('/api/chamados', {
    method: 'POST',
    body: JSON.stringify({ pessoa, papel, turma_id: turmaId, motivo: 'Chamado pela secretaria' }),
  });
  toast(`${pessoa} chamado(a).`);
}

function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  state.ws = new WebSocket(`${proto}://${location.host}`);
  state.ws.addEventListener('message', async (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.tipo === 'sync') await loadData();
      if (msg.tipo === 'chamado' && msg.chamado) toast(`Chamado: ${msg.chamado.pessoa}`);
    } catch {}
  });
  state.ws.addEventListener('close', () => setTimeout(connectWs, 2000));
}

document.addEventListener('click', async (event) => {
  const target = event.target.closest('button');
  if (!target) return;

  const toggle = target.dataset.toggle;
  if (toggle) {
    const id = Number(toggle);
    if (state.collapsed.has(id)) state.collapsed.delete(id);
    else state.collapsed.add(id);
    render();
    return;
  }

  const exportId = target.dataset.export;
  if (exportId) return exportCsv(Number(exportId));

  const editId = target.dataset.edit;
  if (editId) return openStudentModal(state.alunos.find((a) => a.id === Number(editId)));

  const deleteId = target.dataset.delete;
  if (deleteId && confirm('Excluir este aluno?')) {
    await api(`/api/alunos/${deleteId}`, { method: 'DELETE' });
    await loadData();
    toast('Aluno excluido.');
    return;
  }

  const studentCall = target.dataset.callStudent;
  if (studentCall) {
    const aluno = state.alunos.find((a) => a.id === Number(studentCall));
    return createCall(aluno.nome, 'aluno', aluno.turma_id);
  }

  const profCall = target.dataset.callProf;
  if (profCall) {
    const turma = state.turmas.find((t) => t.id === Number(profCall));
    return createCall(turma.professora, 'professora', turma.id);
  }

  const auxCall = target.dataset.callAux;
  if (auxCall) {
    const turma = state.turmas.find((t) => t.id === Number(auxCall));
    return createCall(turma.auxiliar, 'auxiliar', turma.id);
  }

  if (target.dataset.close !== undefined) closeModal();
});

el('searchInput').addEventListener('input', render);
el('turmaFilter').addEventListener('change', render);
el('tipoFilter').addEventListener('change', render);
el('reloadBtn').addEventListener('click', loadData);
el('newStudentBtn').addEventListener('click', () => openStudentModal());
el('studentForm').addEventListener('submit', saveStudent);
el('themeBtn').addEventListener('click', () => {
  const dark = document.documentElement.dataset.theme !== 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  localStorage.setItem('theme', dark ? 'dark' : 'light');
  el('themeBtn').textContent = dark ? 'Modo claro' : 'Modo escuro';
});

document.documentElement.dataset.theme = localStorage.getItem('theme') || 'light';
el('themeBtn').textContent = document.documentElement.dataset.theme === 'dark' ? 'Modo claro' : 'Modo escuro';

loadData().catch((err) => toast(err.message));
checkServer();
setInterval(checkServer, 10000);
connectWs();
