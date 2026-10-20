const replica = {
  disciplina: '',
  turma: localStorage.getItem('turma') || '1º ANO A MATUTINO - 1º Ano (U I PEDR...',
  registros: [],
  logado: false,

  async init() {
    this.bindDropdown();
    this.bindForm();
    this.verificarLogin();
  },

  verificarLogin() {
    const cpf = localStorage.getItem('cpf');
    const senha = localStorage.getItem('senha');
    if (!cpf || !senha) {
      this.mostrarLogin();
      return;
    }
    // verifica se sessão ainda válida
    fetch(`/api/auth/status?cpf=${cpf}`).then(r=>r.json()).then(s=>{
      if (s.logado) {
        this.logado = true;
        this.esconderLogin(s);
        this.refresh();
        this.renderComandos();
      } else {
        this.mostrarLogin();
      }
    }).catch(()=> this.mostrarLogin());
  },
  mostrarLogin() {
    document.getElementById('login-overlay').classList.remove('hidden');
    document.getElementById('sync-status').textContent = '● Aguardando login';
    // esconde conteúdo clonado até logar
    document.getElementById('comandos-card').style.display = 'none';
    document.getElementById('empty-state').style.display = 'none';
    document.getElementById('content-selected').style.display = 'none';
  },
  esconderLogin(sess) {
    document.getElementById('login-overlay').classList.add('hidden');
    document.getElementById('comandos-card').style.display = '';
    document.getElementById('sync-status').style.color = '#10b981';
    document.getElementById('btn-logout').style.display = '';
    localStorage.setItem('modo', 'real');
    if (sess) {
      document.getElementById('sync-status').textContent = `● Clonado • ${sess.turmas?.length||1} turmas • Modo REAL`;
      document.getElementById('sync-status').title = 'Gerar & Lançar já grava no site oficial';
    } else {
      document.getElementById('sync-status').textContent = '● Sincronizado • Modo REAL';
    }
    this.showEmpty();
  },
  async fazerLogin() {
    const cpf = document.getElementById('login-cpf').value.trim();
    const senha = document.getElementById('login-senha').value;
    const url = document.getElementById('login-url').value.trim();
    const erro = document.getElementById('login-erro');
    const btn = document.getElementById('btn-login');
    if (!cpf || !senha) { erro.textContent='Preencha CPF e senha'; erro.classList.remove('hidden'); return; }
    const cpfNum = cpf.replace(/\D/g,'');
    if (cpfNum.length !== 11) { erro.textContent='CPF deve ter 11 dígitos (só números). Ex: 88339211315'; erro.classList.remove('hidden'); return; }
    btn.disabled = true; btn.textContent = 'Clonando...'; erro.classList.add('hidden');
    try {
      const r = await API.post('/api/auth/login', { cpf: cpfNum, senha });
      localStorage.setItem('cpf', cpfNum);
      localStorage.setItem('senha', senha);
      localStorage.setItem('modo', 'real');
      if (url) localStorage.setItem('cfg-url', url);
      this.logado = true;
      this.esconderLogin(r);
      await this.refresh();
      await this.renderComandos();
      this.toast(`Bem-vindo! Site clonado: ${r.turmas?.length||1} turmas • Modo REAL ativado`, 'success');
    } catch (e) {
      let msg = e.message || 'Falha no login. Verifique CPF/senha.';
      // se for erro de rede do preview, explica
      if (e.message && (e.message.includes('Preview online') || e.message.includes('LOCALMENTE') || e.message.includes('503'))) {
        msg = 'Preview online bloqueado (normal). Rode no seu PC: feche esta aba, abra INICIAR.bat no seu PC, acesse http://localhost:3000/replica.html e faça login lá — vai funcionar. Ou clique "Continuar sem login" para testar agora.';
      }
      erro.innerHTML = msg + '<br><small style="color:#64748b">Dica: CPF sem pontos/traço, senha igual do EduGestão. Se insistir, clique em Continuar sem login para usar modo local.</small>';
      erro.classList.remove('hidden');
      console.error('login erro', e);
    } finally { btn.disabled = false; btn.textContent = 'Entrar e clonar site →'; }
  },
  usarModoLocal() {
    document.getElementById('login-overlay').classList.add('hidden');
    document.getElementById('comandos-card').style.display = '';
    document.getElementById('sync-status').textContent = '● Modo local (sem clone)';
    document.getElementById('sync-status').style.color = '#f59e0b';
    localStorage.setItem('modo', 'simulado');
    this.showEmpty();
    this.refresh();
    this.renderComandos();
    this.toast('Modo local ativado. Faça login para clonar o site real.', 'info');
  },
  logout() {
    const cpf = localStorage.getItem('cpf');
    API.post('/api/auth/logout', { cpf }).catch(()=>{});
    localStorage.removeItem('cpf'); localStorage.removeItem('senha');
    localStorage.setItem('modo','simulado');
    this.logado = false;
    document.getElementById('btn-logout').style.display='none';
    this.mostrarLogin();
    this.toast('Desconectado • Voltou ao modo local','info');
  },

  bindDropdown() {
    const btn = document.getElementById('btn-disc');
    const dd = document.getElementById('dropdown-disc');
    btn.addEventListener('click', () => dd.classList.toggle('open'));
    document.addEventListener('click', e => {
      if (!e.target.closest('#select-disc-wrap')) dd.classList.remove('open');
    });
    dd.querySelectorAll('.dropdown-item').forEach(el => {
      el.addEventListener('click', () => {
        this.disciplina = el.dataset.value;
        document.getElementById('label-disc').textContent = this.disciplina;
        document.getElementById('label-disc').classList.remove('placeholder');
        dd.classList.remove('open');
        dd.querySelectorAll('.dropdown-item').forEach(x => x.classList.remove('selected'));
        el.classList.add('selected');
        this.onDisciplinaChange();
      });
    });
  },

  bindForm() {
    const inputData = document.getElementById('form-data');
    inputData.addEventListener('change', () => {
      const d = new Date(inputData.value + 'T12:00:00');
      const dias = ['Domingo','Segunda-feira','Terça-feira','Quarta-feira','Quinta-feira','Sexta-feira','Sábado'];
      document.getElementById('form-dia-hint').textContent = dias[d.getDay()] || '';
    });
  },

  async refresh() {
    try {
      const [regs, estado] = await Promise.all([
        API.get('/api/registros').catch(()=>[]),
        API.get('/api/replica/estado').catch(()=>null)
      ]);
      this.registros = regs;
      if (estado) this.renderMeta(estado);
      else {
        const prog = await API.get('/api/progresso').catch(()=>null);
        if(prog) this.renderMeta({ ...prog, tabela: null });
      }
      if (this.disciplina) this.renderRegistros();
      else this.showEmpty();
    } catch (e) { console.error(e) }
  },

  async renderComandos() {
    const grid = document.getElementById('comandos-grid');
    try {
      const proximos = await API.get('/api/proximos-dias?qtd=4');
      grid.innerHTML = '';
      for (let i=0;i<proximos.length;i++) {
        const d = proximos[i];
        const label = i===0 ? 'HOJE' : i===1 ? 'AMANHA' : d.diaSemanaLabel.toUpperCase();
        const ja = this.registros.filter(r => r.data === d.data).length;
        const total = d.materias.length;
        const chips = d.materias.map(m => {
          const cls = m.disciplina==='Língua Portuguesa'?'lp':m.disciplina==='Matemática'?'mat':m.disciplina==='Arte'?'arte':m.disciplina==='Ciências'?'ci':m.disciplina==='Educação Física'?'ef':'er';
          return `<span class="chip ${cls}">${m.disciplina} ${m.aulas}a</span>`;
        }).join('') || '<small style="color:#94a3b8">Sem aula</small>';
        const btn = d.letivo && total>0 ? `<button class="btn-gerar" onclick="replica.gerarDia('${d.data}')">${ja? 'Regerar':'Gerar & Lancar'}</button>` : '';
        const div = document.createElement('div');
        div.className = 'cmd-card' + (i===0?' hoje':'');
        div.innerHTML = `<div style="display:flex;justify-content:space-between"><span style="font-size:11px;font-weight:700;color:#0ea5e9">${label}</span><span style="font-size:11px">${ja? ja+'/'+total+' ✓':''}</span></div><div class="cmd-date">${d.data.split('-').reverse().join('/')}</div><div class="cmd-day">${d.diaSemanaLabel} • ${d.letivo? d.totalAulas+' aulas • '+d.bimestre:'Nao letivo'}</div><div class="cmd-materias">${chips}</div>${btn}`;
        grid.appendChild(div);
      }
    } catch(e){ grid.innerHTML = '<p style="color:#94a3b8">Erro ao carregar</p>' }
  },

  renderMeta(estado) {
    // estado vem de /api/replica/estado (fiel) ou /api/progresso (fallback)
    const tabela = estado.tabela;
    const prog = estado.linhas ? { linhas: estado.linhas, ...estado } : estado;
    const geral = estado.progressoGeral ?? estado.progresso?.progressoGeral ?? prog.progressoGeral ?? 0;
    const totalAulas = estado.totalAulas ?? estado.totalRealizado ?? 0;
    document.getElementById('progress-fill').style.width = geral + '%';
    document.getElementById('progress-text').textContent = `Progresso geral: ${geral}%`;
    document.getElementById('badge-registros').textContent = `${totalAulas} aulas • ${estado.totalRegistros ?? estado.totalRealizado ?? 0} dias no ano`;
    document.getElementById('badge-calendario').textContent = `Calendário 2026: 200 dias letivos`;

    const tbody = document.getElementById('meta-tbody');
    if (!tbody) return;
    // usa tabela fiel se disponível
    if (tabela && Array.isArray(tabela)) {
      tbody.innerHTML = '';
      const ordem = ['Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
      for (const row of tabela) {
        const tr = document.createElement('tr');
        let tds = `<td style="text-align:left;font-weight:600">${row.disciplina}</td>`;
        for (const m of ordem) {
          const v = row.meses[m] || 0;
          let cls='gray', txt='-';
          if (v>0) { cls = v>=5?'green': v>=3?'green':'orange'; txt=v; }
          // laranja para parcial (como print: valores pequenos em laranja)
          if (row.progresso !== undefined && v>0 && v<3) cls='orange';
          tds += `<td><span class="pill ${cls}">${txt}</span></td>`;
        }
        const total = row.meses.totalReal ?? row.progresso ?? 0;
        // totalReal já é soma das aulas; meta está em row.meses.totalMeta
        const meta = row.meses.totalMeta ?? 0;
        // exibe como 22/78 etc (igual print oficial)
        const realExibir = row.meses.totalReal !== undefined ? row.meses.totalReal : total;
        tds += `<td><strong>${realExibir}<span style="color:#94a3b8">/${meta}</span></strong></td>`;
        tr.innerHTML = tds;
        tbody.appendChild(tr);
      }
      return;
    }
    // fallback antigo (se tabela não veio)
    if (!prog.linhas) return;
    tbody.innerHTML = '';
    const mock = {
      'Arte':[6,8,6,2,0,0,0,0,0,0,0],
      'Ciências':[5,8,8,2,0,0,0,0,0,0,0],
      'Educação Física':[3,4,3,1,0,0,0,0,0,0,0],
      'Ensino Religioso':[2,5,4,1,0,0,0,0,0,0,0],
      'Língua Portuguesa':[12,23,20,5,0,0,0,0,0,0,0],
      'Matemática':[12,20,23,5,0,0,0,0,0,0,0],
    };
    for (const l of prog.linhas) {
      const tr = document.createElement('tr');
      let tds = `<td>${l.disciplina}</td>`;
      const meses = mock[l.disciplina] || [0,0,0,0,0,0,0,0,0,0,0];
      for (let i=0;i<11;i++) {
        const v = (prog.totalRealizado < 20 && mock[l.disciplina]) ? meses[i] : (i===3 ? Math.min(l.realizado,2) : 0);
        let cls='gray', txt='-';
        if (v>0) { cls = v>=3?'green':'orange'; txt=v; }
        tds += `<td><span class="pill ${cls}">${txt}</span></td>`;
      }
      const total = l.realizado || (mock[l.disciplina]? mock[l.disciplina].reduce((a,b)=>a+b,0) : 0);
      const meta = l.meta;
      tds += `<td><strong>${total}<span style="color:#94a3b8">/${meta}</span></strong></td>`;
      tr.innerHTML = tds;
      tbody.appendChild(tr);
    }
  },

  onDisciplinaChange() {
    document.getElementById('empty-state').style.display = 'none';
    document.getElementById('content-selected').style.display = 'block';
    document.getElementById('registros-subtitle').textContent = `1º ANO A MATUTINO • 1º Ano • Matutino • ${this.disciplina}`;
    this.renderRegistros();
  },

  showEmpty() {
    document.getElementById('empty-state').style.display = 'block';
    document.getElementById('content-selected').style.display = 'none';
  },

  renderRegistros() {
    const tbody = document.getElementById('registros-tbody');
    let regs = [...this.registros].sort((a,b)=> b.data.localeCompare(a.data));
    if (this.disciplina) regs = regs.filter(r=> r.disciplina===this.disciplina);
    if (regs.length===0) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:#94a3b8;padding:20px">Nenhum registro ainda • Clique em Comandos Diários para gerar</td></tr>`;
      return;
    }
    tbody.innerHTML = regs.map(r => {
      const d = new Date(r.data+'T12:00:00');
      const dias = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
      // bimestre
      const bim = r.bimestre || '2º Bim.';
      return `<tr>
        <td><strong>${r.data.split('-').reverse().join('/')}</strong></td>
        <td>${['Segunda-feira','Terça-feira','Quarta-feira','Quinta-feira','Sexta-feira','Sábado','Domingo'][d.getDay()]|| dias[d.getDay()]}</td>
        <td><span style="background:#f1f5f9;border:1px solid #e2e8f0;padding:4px 8px;border-radius:999px;font-size:11px">${bim}</span></td>
        <td>${r.quantidadeAulas}</td>
        <td><div style="max-width:320px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${this.esc(r.conteudo)}">${this.esc(r.conteudo)}</div></td>
        <td><span class="status">${r.status||'Validado'}</span></td>
        <td class="actions"><button onclick="replica.ver('${r.id}')" title="Ver">👁️</button><button onclick="replica.editar('${r.id}')" title="Editar">✏️</button><button onclick="replica.excluir('${r.id}')" title="Excluir">🗑️</button></td>
      </tr>`;
    }).join('');
  },

  async gerarDia(data) {
    const info = await API.get('/api/calendario/dia/'+data);
    if (!info.letivo) return this.toast('Dia não letivo','error');
    const modo = this.logado ? 'real' : (localStorage.getItem('modo') || 'simulado');
    const previews = info.previews || [];
    const html = `<p>Vai gerar <strong>${previews.length} registro(s)</strong> para <strong>${info.formatBR} (${info.diaSemanaLabel})</strong></p>
      <div style="margin:12px 0">${previews.map(p=> `<div style="border:1px solid #e2e8f0;border-radius:10px;padding:10px;margin-bottom:8px;background:#f8fafc"><strong>${p.disciplina} • ${p.aulas} aula(s) • ${p.bimestre}</strong><p style="margin:6px 0;font-size:13px">${p.conteudo}</p><small style="color:#64748b">Obs: ${p.observacao}</small></div>`).join('')}</div>
      <p style="font-size:11px;color:#64748b">Modo: <strong>${modo}</strong> • Frequência: todos presentes</p>`;
    this.modal('Gerar Aula - '+info.formatBR, html, [
      {label:'Cancelar', fn:()=> this.fecharModal(), cls:'btn-cancel'},
      {label:'Gerar & Lançar', fn:()=> this.confirmGerar(data), cls:'btn-save'}
    ]);
  },

  async confirmGerar(data) {
    this.fecharModal();
    this.toast('Gerando...','info');
    try {
      const modo = this.logado ? 'real' : (localStorage.getItem('modo')||'simulado');
      const cpf = localStorage.getItem('cpf');
      const res = await API.post('/api/gerar-dia', {data, modo, cpf});
      this.registros = await API.get('/api/registros');
      this.renderRegistros();
      this.renderComandos();
      // atualiza meta
      const prog = await API.get('/api/progresso');
      this.renderMeta(prog);
      const total = res.totalGerados || res.resultados?.filter(r=>r.status==='sucesso').length || 0;
      this.toast(`${total} aula(s) lançada(s) para ${data.split('-').reverse().join('/')} ✓`, 'success');
      const detalhes = (res.resultados||[]).map(r=> `<li>${r.disciplina} - ${r.aulas} aula(s) - ${r.status==='sucesso'?'✅ Validado':r.status}</li>`).join('');
      this.modal('✅ Dia Confirmado', `<p>Lançado em <strong>${data.split('-').reverse().join('/')}</strong>:</p><ul style="margin:10px 0 0 18px">${detalhes}</ul><p style="margin-top:10px;color:#15803d;font-weight:600">✓ Réplica sincronizada • ${modo==='real'?'Também no EduGestão':'Modo local (sincronize depois)'}</p>`, [{label:'Fechar', fn:()=>this.fecharModal(), cls:'btn-save'}]);
    } catch(e){ this.toast(e.message,'error') }
  },

  novoRegistro() {
    if (!this.disciplina) return this.toast('Selecione uma disciplina primeiro','error');
    // abre form fiel ao print 3
    const hoje = new Date().toISOString().slice(0,10);
    document.getElementById('form-card').style.display = 'block';
    document.getElementById('form-data').value = hoje;
    document.getElementById('form-dia-hint').textContent = this.diaLabel(hoje);
    document.getElementById('form-qtd').value = 2;
    document.getElementById('form-card').scrollIntoView({behavior:'smooth'});
    // preenche sugestão
    API.post('/api/preview', {disciplina:this.disciplina, data:hoje}).then(p=>{
      document.getElementById('form-conteudo').value = p.conteudo;
      document.getElementById('form-obs').value = p.observacao;
    }).catch(()=>{});
  },

  fecharForm(){ document.getElementById('form-card').style.display='none' },

  async salvarForm(){
    const data = document.getElementById('form-data').value;
    const qtd = parseInt(document.getElementById('form-qtd').value)||1;
    const conteudo = document.getElementById('form-conteudo').value;
    const obs = document.getElementById('form-obs').value;
    if (!data || !this.disciplina || !conteudo) return this.toast('Preencha data, disciplina e conteúdo','error');
    try{
      const modo = this.logado ? 'real' : (localStorage.getItem('modo')||'simulado');
      const cpf = localStorage.getItem('cpf');
      await API.post('/api/registros', {data, disciplina:this.disciplina, quantidadeAulas:qtd, conteudo, observacoes:obs, modo, cpf});
      this.fecharForm();
      this.registros = await API.get('/api/registros');
      this.renderRegistros();
      this.renderComandos();
      this.toast('Registro salvo ✓','success');
    }catch(e){ this.toast(e.message,'error') }
  },

  async sincronizar(){
    this.toast('Sincronizando com EduGestão...','info');
    try{
      const r = await API.post('/api/sincronizar', {});
      this.toast(r.message||'Sincronizado!','success');
      this.refresh();
    }catch(e){ this.toast(e.message,'error') }
  },

  ver(id){
    const r=this.registros.find(x=>x.id===id);
    if(!r) return;
    this.modal(`${r.disciplina} - ${r.data.split('-').reverse().join('/')}`, `<p><strong>Turma:</strong> ${r.turma}</p><p><strong>Data:</strong> ${r.data.split('-').reverse().join('/')} • ${r.bimestre}</p><p><strong>Aulas:</strong> ${r.quantidadeAulas}</p><div style="background:#f8fafc;border:1px solid #e2e8f0;padding:12px;border-radius:10px;margin:10px 0"><strong>Conteúdo:</strong><br>${this.esc(r.conteudo)}</div><p><span class="status">${r.status}</span></p>`, [{label:'Fechar',fn:()=>this.fecharModal(),cls:'btn-save'}]);
  },
  async excluir(id){
    if(!confirm('Excluir este registro?')) return;
    await API.del('/api/registros/'+id);
    this.registros = await API.get('/api/registros');
    this.renderRegistros();
    this.renderComandos();
    this.toast('Excluído','success');
  },
  editar(id){ this.ver(id) },

  modal(title, body, actions){
    let d=document.getElementById('modal-replica');
    if(!d){
      d=document.createElement('div');
      d.id='modal-replica';
      d.style.cssText='position:fixed;inset:0;display:grid;place-items:center;z-index:100;background:rgba(0,0,0,.5);padding:20px';
      d.innerHTML='<div style="background:#fff;border-radius:12px;max-width:640px;width:100%;max-height:90vh;overflow:auto"><div style="padding:16px;border-bottom:1px solid #e2e8f0;display:flex;justify-content:space-between;align-items:center"><h3 id="m-title"></h3><button onclick="replica.fecharModal()" style="border:none;background:none;cursor:pointer;font-size:18px">✕</button></div><div id="m-body" style="padding:16px"></div><div id="m-actions" style="padding:16px;display:flex;justify-content:flex-end;gap:10px"></div></div>';
      document.body.appendChild(d);
      d.addEventListener('click', e=>{ if(e.target===d) replica.fecharModal() });
    }
    d.style.display='grid';
    document.getElementById('m-title').textContent=title;
    document.getElementById('m-body').innerHTML=body;
    const act=document.getElementById('m-actions');
    act.innerHTML=actions.map((a,i)=> `<button class="${a.cls}" data-i="${i}">${a.label}</button>`).join('');
    actions.forEach((a,i)=> act.querySelector(`[data-i="${i}"]`).onclick=a.fn);
  },
  fecharModal(){ const d=document.getElementById('modal-replica'); if(d) d.style.display='none'; },
  toast(msg,type='info'){
    const el=document.getElementById('toast');
    el.textContent=msg;
    el.className='toast '+(type==='success'?'success':type==='error'?'error':'');
    el.classList.remove('hidden');
    setTimeout(()=> el.classList.add('hidden'), 4000);
  },
  esc(s){ return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') },
  diaLabel(iso){ const d=new Date(iso+'T12:00:00'); return ['Domingo','Segunda-feira','Terça-feira','Quarta-feira','Quinta-feira','Sexta-feira','Sábado'][d.getDay()] }
};

document.addEventListener('DOMContentLoaded', ()=> replica.init());
