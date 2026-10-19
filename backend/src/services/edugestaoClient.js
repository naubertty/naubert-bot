import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BASE_URL = process.env.EDUGESTAO_URL || 'https://lagoverde.edugestao.com';
export class EduGestaoClient {
  constructor({cpf,senha,headless=true,slowMo=0}={}){ this.cpf=cpf||process.env.EDUGESTAO_CPF; this.senha=senha||process.env.EDUGESTAO_SENHA; this.headless=headless; this.slowMo=slowMo; this.browser=null; this.context=null; this.page=null; this.logged=false; }
  async init(){ if(this.browser) return; this.browser=await chromium.launch({headless:this.headless,slowMo:this.slowMo}); this.context=await this.browser.newContext({viewport:{width:1366,height:768},userAgent:'Mozilla/5.0',locale:'pt-BR',timezoneId:'America/Sao_Paulo'}); this.page=await this.context.newPage(); this.page.setDefaultTimeout(30000); }
  async close(){ if(this.browser){ await this.browser.close(); this.browser=null; this.context=null; this.page=null; } }
  async login(){
    await this.init();
    const page=this.page;
    try{
      await page.goto(`${BASE_URL}/auth`,{waitUntil:'domcontentloaded',timeout:20000});
    }catch(e){
      // network error - likely sandbox restriction
      throw new Error(`Não foi possível acessar ${BASE_URL}/auth : ${e.message}. Se está testando no preview online, rode LOCALMENTE com INICIAR.bat no seu PC para login real funcionar.`);
    }
    // se já estiver logado, vai direto pra /professor
    await page.waitForTimeout(1500);
    if(page.url().includes('/professor') || page.url().includes('/calendario') || page.url().includes('/diario')){
      this.logged=true; return true;
    }
    // tenta achar campos - EduGestão usa CPF e Senha
    const cpfSelectors=['input[name="cpf"]','input[name="login"]','input[placeholder*="CPF" i]','input[type="text"]','#cpf','input[name="username"]'];
    const senhaSelectors=['input[name="password"]','input[name="senha"]','input[type="password"]','#senha','#password','input[name="pass"]'];
    const btnSelectors=['button:has-text("Entrar")','button:has-text("Acessar")','button[type="submit"]','input[type="submit"]','button:has-text("Login")'];
    // espera qualquer input aparecer
    let foundInput = false;
    for(let i=0;i<4;i++){
      for(const sel of cpfSelectors){
        try{ if(await page.locator(sel).first().isVisible({timeout:800})){ foundInput=true; break; } }catch{}
      }
      if(foundInput) break;
      await page.waitForTimeout(700);
    }
    if(!foundInput){
      // salva html/screenshot para debug
      try{
        const dir=path.join(__dirname,'../../../data/logs'); fs.mkdirSync(dir,{recursive:true});
        const html=await page.content(); fs.writeFileSync(path.join(dir,`login-${Date.now()}-page.html`), html);
        await page.screenshot({path:path.join(dir,`login-${Date.now()}-fail.png`),fullPage:true});
      }catch{}
      throw new Error('Página de login não carregou corretamente (campos CPF não encontrados). O site pode estar fora do ar ou bloqueando acesso do preview. Rode localmente com INICIAR.bat.');
    }
    let cpfFilled=false;
    for(const sel of cpfSelectors){
      try{
        const el=page.locator(sel).first();
        if(await el.isVisible({timeout:1500})){
          await el.click({timeout:2000});
          await el.fill('', {timeout:2000});
          await page.waitForTimeout(300);
          await el.fill(this.cpf, {timeout:3000});
          // confirma que preencheu
          const v=await el.inputValue().catch(()=> '');
          if(v && v.replace(/\D/g,'').length>=5) { cpfFilled=true; break; }
        }
      }catch{}
    }
    if(!cpfFilled) throw new Error('Não consegui preencher o CPF. Tente novamente ou use o modo local.');
    let senhaFilled=false;
    for(const sel of senhaSelectors){
      try{
        const el=page.locator(sel).first();
        if(await el.isVisible({timeout:1500})){
          await el.click();
          await el.fill(this.senha, {timeout:3000});
          senhaFilled=true; break;
        }
      }catch{}
    }
    if(!senhaFilled) throw new Error('Não consegui preencher a senha.');
    // clica Entrar
    let clicked=false;
    for(const sel of btnSelectors){
      try{
        const el=page.locator(sel).first();
        if(await el.isVisible({timeout:1500})){
          await el.click({timeout:3000});
          clicked=true; break;
        }
      }catch{}
    }
    if(!clicked){
      await page.keyboard.press('Enter').catch(()=>{});
    }
    // espera navegar
    try{ await page.waitForLoadState('networkidle',{timeout:15000}); }catch{}
    await page.waitForTimeout(2000);
    const url=page.url();
    // sucesso se saiu de /auth
    if(!url.includes('/auth') || url.includes('/professor') || url.includes('/calendario')){
      this.logged=true;
      try{
        const storage=await this.context.storageState();
        const dir=path.join(__dirname,'../../../data/sessions');
        fs.mkdirSync(dir,{recursive:true});
        fs.writeFileSync(path.join(dir,'session.json'),JSON.stringify(storage,null,2));
      }catch{}
      return true;
    }
    // ainda em /auth - pega erro da página
    let erroMsg='';
    try{
      // procura mensagens de erro comuns
      const alertas = await page.locator('.alert, .alert-danger, .alert-warning, .error, [role="alert"], .invalid-feedback, .text-danger').all();
      for(const a of alertas){
        if(await a.isVisible().catch(()=>false)){
          const t=await a.textContent().catch(()=> '');
          if(t && t.trim().length>3) { erroMsg=t.trim(); break; }
        }
      }
      // se não achou, tenta toast
      if(!erroMsg){
        const toast=await page.locator('.toast, .swal2-html-container, .modal-body').first().textContent().catch(()=> '');
        if(toast && toast.trim().length>3) erroMsg=toast.trim();
      }
    }catch{}
    // salva evidência
    try{
      const dir=path.join(__dirname,'../../../data/logs'); fs.mkdirSync(dir,{recursive:true});
      await page.screenshot({path:path.join(dir,`login-falha-${Date.now()}.png`),fullPage:true});
    }catch{}
    if(erroMsg){
      throw new Error(`Falha no login: ${erroMsg}`);
    }
    throw new Error('Falha no login: CPF ou senha inválidos. Verifique e tente novamente. Se o site estiver fora do ar, use modo local.');
  }
  async ensureLogged(){ if(!this.logged) await this.login(); }
  async getTurmasEDisciplinas(){ await this.ensureLogged(); const page=this.page; const urls=[`${BASE_URL}/professor/diario`,`${BASE_URL}/professor/calendario`,`${BASE_URL}/professor`]; for(const u of urls){ try{ await page.goto(u,{waitUntil:'networkidle',timeout:15000}); if(await page.locator('text=Diário de Classe').count()>0) break; }catch{} }
    const turmas=[], disciplinas=[]; try{
      const turmaOptions=await page.$$eval('select', selects=> selects.map(s=>({id:s.id,name:s.name,options:[...s.options].map(o=>({value:o.value,text:o.textContent.trim()}))})) ).catch(()=>[]);
      for(const sel of turmaOptions){ for(const opt of sel.options){ if(/ANO/i.test(opt.text)||/MATUTINO|VESPERTINO/i.test(opt.text)) turmas.push(opt); } }
      const disciplinaDropdown=page.locator('text=Escolha uma disciplina').first(); if(await disciplinaDropdown.isVisible().catch(()=>false)){ await disciplinaDropdown.click(); const opts=await page.locator('text=Arte').first().isVisible().catch(()=>false); if(opts){ const all=await page.$$eval('[role="option"], li', els=> els.map(e=> e.textContent.trim())); for(const t of all){ if(['Arte','Ciências','Ciencias','Educação Física','Ensino Religioso','Língua Portuguesa','Matemática','Matematica','História','Geografia'].some(d=> t.includes(d))) disciplinas.push({value:t,text:t}); } await page.keyboard.press('Escape'); } }
      if(turmas.length===0||disciplinas.length===0){ const apiTurmas=await this.tryApiTurmas(); if(apiTurmas.turmas) turmas.push(...apiTurmas.turmas); if(apiTurmas.disciplinas) disciplinas.push(...apiTurmas.disciplinas); }
    }catch(e){ console.warn('[EduGestão] Erro extraindo:',e.message); }
    if(turmas.length===0) turmas.push({value:'1',text:'1º ANO A MATUTINO - 1º Ano (U I PEDRO LEONARDO)'}); if(disciplinas.length===0) disciplinas.push({value:'Arte',text:'Arte'},{value:'Ciências',text:'Ciências'},{value:'Educação Física',text:'Educação Física'},{value:'Ensino Religioso',text:'Ensino Religioso'},{value:'Língua Portuguesa',text:'Língua Portuguesa'},{value:'Matemática',text:'Matemática'});
    return {turmas,disciplinas};
  }
  async tryApiTurmas(){ const page=this.page; const candidates=[`${BASE_URL}/api/turmas`,`${BASE_URL}/api/professor/turmas`,`${BASE_URL}/professor/api/turmas`,`${BASE_URL}/professor/turmas`]; for(const url of candidates){ try{ const res=await page.request.get(url); if(res.ok()){ const json=await res.json().catch(()=>null); if(json) return {turmas:json.turmas||json.data||json,disciplinas:json.disciplinas||[]}; } }catch{} } return {}; }
  async criarRegistroAula({turma,disciplina,data,quantidadeAulas=1,conteudo,observacoes='',frequencia='todos_presentes'}){
    await this.ensureLogged(); const page=this.page; const dataBR=this.toBR(data);
    await page.goto(`${BASE_URL}/professor/diario`,{waitUntil:'networkidle'}).catch(()=> page.goto(`${BASE_URL}/professor/calendario`,{waitUntil:'networkidle'}));
    await this.selecionarTurma(turma); await page.waitForTimeout(1000); await this.selecionarDisciplina(disciplina); await page.waitForTimeout(1500);
    const jaExiste=await this.verificarRegistroExistente(data,disciplina); if(jaExiste) return {status:'ja_existe',jaExiste};
    const novoBtn=page.locator('button:has-text("Novo Registro"), a:has-text("Novo Registro"), button:has-text("Novo")').first();
    if(await novoBtn.isVisible({timeout:5000}).catch(()=>false)) await novoBtn.click(); else { const plus=page.locator('button:has-text("+")').first(); if(await plus.isVisible().catch(()=>false)) await plus.click(); else throw new Error('Botão Novo Registro não encontrado'); }
    await page.waitForLoadState('networkidle');
    let dataPreenchida=false; for(const sel of ['input[type="date"]','input[name="data"]']){ try{ const el=page.locator(sel).first(); if(await el.isVisible({timeout:1000})){ await el.fill(data); dataPreenchida=true; break; } }catch{} }
    if(!dataPreenchida){ const labelDate=page.locator('text=Data da Aula').locator('..').locator('input').first(); if(await labelDate.isVisible().catch(()=>false)){ await labelDate.fill(dataBR); dataPreenchida=true; } }
    const alertaHorario=page.locator('text=Não há aulas desta disciplina previstas'); if(await alertaHorario.isVisible({timeout:2000}).catch(()=>false)) console.warn('Alerta horário');
    const qtdInput=page.locator('text=Quantidade de Aulas').locator('..').locator('input').first(); if(await qtdInput.isVisible({timeout:2000}).catch(()=>false)) await qtdInput.fill(String(quantidadeAulas)); else { const qtdAlt=page.locator('input[name="quantidade"], input[name="qtd"], input[type="number"]').first(); if(await qtdAlt.isVisible().catch(()=>false)) await qtdAlt.fill(String(quantidadeAulas)); }
    let conteudoPreenchido=false; for(const sel of ['textarea[name="conteudo"]','textarea[placeholder*="Conteúdo" i]','textarea[placeholder*="Descreva" i]']){ try{ const el=page.locator(sel).first(); if(await el.isVisible({timeout:2000})){ await el.fill(conteudo); conteudoPreenchido=true; break; } }catch{} }
    if(!conteudoPreenchido){ const area=page.locator('text=Conteúdo Ministrado').locator('..').locator('textarea').first(); if(await area.isVisible().catch(()=>false)) await area.fill(conteudo); }
    if(observacoes){ const obsTA=page.locator('text=Observações').locator('..').locator('textarea').first(); if(await obsTA.isVisible({timeout:2000}).catch(()=>false)) await obsTA.fill(observacoes); }
    try{ const freqSection=page.locator('text=Frequência dos Alunos'); if(await freqSection.isVisible({timeout:2000})){ const checkboxes=page.locator('input[type="checkbox"]'); const count=await checkboxes.count(); for(let i=0;i<count;i++){ const cb=checkboxes.nth(i); if(await cb.isVisible()){ const checked=await cb.isChecked().catch(()=>false); if(!checked) await cb.check().catch(()=>{}); } } } }catch{}
    const salvarBtn=page.locator('button:has-text("Salvar"), button:has-text("Salvar Registro"), button:has-text("Confirmar")').first();
    if(await salvarBtn.isVisible({timeout:3000}).catch(()=>false)) await salvarBtn.click(); else await page.keyboard.press('Control+Enter');
    await page.waitForLoadState('networkidle',{timeout:10000}).catch(()=>{});
    const sucesso=page.locator('text=Registro criado, text=Salvo com sucesso, text=Validado, .toast-success'); const hasSucesso=await sucesso.first().isVisible({timeout:5000}).catch(()=>false);
    try{ const dir=path.join(__dirname,'../../../data/logs'); fs.mkdirSync(dir,{recursive:true}); await page.screenshot({path:path.join(dir,`registro-${data}-${disciplina.replace(/\s/g,'_')}.png`),fullPage:true}); }catch{}
    if(hasSucesso) return {status:'sucesso',data,disciplina,quantidadeAulas,conteudo};
    const voltoulista=await page.locator('text=Registros Diários').isVisible({timeout:3000}).catch(()=>false); if(voltoulista) return {status:'sucesso',data,disciplina,quantidadeAulas,conteudo};
    const erro=await page.locator('.alert-danger, .error, text=Erro').first().textContent().catch(()=> ''); return {status:'erro',erro:erro||'Não foi possível confirmar',data,disciplina};
  }
  async selecionarTurma(turmaTexto){ const page=this.page; try{ const select=page.locator('text=Turma:').locator('..').locator('select').first(); if(await select.isVisible({timeout:2000})){ await select.selectOption({label:turmaTexto}); return; } }catch{} try{ const turmaDropdown=page.locator('text=Turma:').locator('..').locator('div, button').filter({hasText:/ANO/}).first(); if(await turmaDropdown.isVisible({timeout:2000})){ await turmaDropdown.click(); const opt=page.locator(`text=${turmaTexto}`).first(); if(await opt.isVisible({timeout:3000})){ await opt.click(); return; } } }catch{} }
  async selecionarDisciplina(disciplina){ const page=this.page; try{ const select=page.locator('text=Disciplina:').locator('..').locator('select').first(); if(await select.isVisible({timeout:2000})){ await select.selectOption({label:disciplina}); return; } }catch{} try{ const discDropdown=page.locator('text=Escolha uma disciplina, text=Disciplina:').last(); if(await discDropdown.isVisible({timeout:2000})){ await discDropdown.click(); await page.waitForTimeout(500); const opt=page.locator(`text=${disciplina}`).first(); if(await opt.isVisible({timeout:3000})){ await opt.click(); return; } } const direct=page.locator(`li:has-text("${disciplina}"), div:has-text("${disciplina}")`).first(); if(await direct.isVisible({timeout:1000}).catch(()=>false)) await direct.click(); }catch{} }
  async verificarRegistroExistente(data,disciplina){ const page=this.page; const br=this.toBR(data); try{ const row=page.locator(`tr:has-text("${br}")`); if(await row.count()>0) return true; }catch{} return false; }
  toBR(iso){ const [y,m,d]=iso.split('-'); return `${d}/${m}/${y}`; }
  async getRegistrosReais(){ const page=this.page; const registros=[]; try{ const linhas=await page.$$('table tbody tr'); for(const linha of linhas){ const cols=await linha.$$('td'); if(cols.length<6) continue; const dataBR=(await cols[0].textContent()).trim(); const dia=(await cols[1].textContent()).trim(); const bimestre=(await cols[2].textContent()).trim(); const aulas=parseInt((await cols[3].textContent()).trim())||1; const conteudo=(await cols[4].textContent()).trim(); const status=(await cols[5].textContent()).trim(); if(!dataBR||!/\d{2}\/\d{2}\/\d{4}/.test(dataBR)) continue; const [d,m,y]=dataBR.split('/'); registros.push({data:`${y}-${m}-${d}`,dataBR,dia,bimestre,aulas,conteudo,status}); } }catch(e){ console.warn('[EduGestão] Erro extrair registros:',e.message); } return registros; }
  async gerarDiaCompleto({data,turma,observacoes='',dryRun=false}){ const {getHorarioDoDia}=await import('./calendarService.js'); const {gerarConteudo,gerarObservacao}=await import('./contentGenerator.js'); const materias=getHorarioDoDia(data); if(materias.length===0) return {status:'sem_aula',data,materias:[]}; const resultados=[]; for(const m of materias){ const conteudoObj=gerarConteudo({disciplina:m.disciplina,dataISO:data}); const obs=observacoes||gerarObservacao({disciplina:m.disciplina}); if(dryRun){ resultados.push({disciplina:m.disciplina,aulas:m.aulas,conteudo:conteudoObj.conteudo,bimestre:conteudoObj.bimestre,status:'simulado'}); continue; } try{ const res=await this.criarRegistroAula({turma,disciplina:m.disciplina,data,quantidadeAulas:m.aulas,conteudo:conteudoObj.conteudo,observacoes:obs}); resultados.push({disciplina:m.disciplina,aulas:m.aulas,...res,conteudo:conteudoObj.conteudo,bimestre:conteudoObj.bimestre}); await this.page.waitForTimeout(2000); }catch(e){ resultados.push({disciplina:m.disciplina,aulas:m.aulas,status:'erro',erro:e.message}); } } return {status:'concluido',data,resultados}; }
}
