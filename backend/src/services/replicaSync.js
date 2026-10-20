import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '../../../data');
const REGISTROS_PATH = path.join(DATA_DIR, 'registros.json');
const SYNC_LOG_PATH = path.join(DATA_DIR, 'sync.log.json');
function loadRegistros(){ try{ return JSON.parse(fs.readFileSync(REGISTROS_PATH,'utf-8')); }catch{ return []; } }
function loadSyncLog(){ try{ return JSON.parse(fs.readFileSync(SYNC_LOG_PATH,'utf-8')); }catch{ return []; } }
function appendSyncLog(entry){ const log=loadSyncLog(); log.unshift({...entry,timestamp:new Date().toISOString()}); if(log.length>100) log.length=100; fs.mkdirSync(DATA_DIR,{recursive:true}); fs.writeFileSync(SYNC_LOG_PATH, JSON.stringify(log,null,2)); }
export function formatarParaReplica(registros){ const diasSemana=['Domingo','Segunda-feira','Terça-feira','Quarta-feira','Quinta-feira','Sexta-feira','Sábado']; return registros.map(r=>{ const d=new Date(r.data+'T12:00:00'); return {id:r.id,data:r.data,dataBR:r.data.split('-').reverse().join('/'),dia:diasSemana[d.getDay()],bimestre:r.bimestre||'2º Bim.',aulas:r.quantidadeAulas,conteudo:r.conteudo,conteudoCurto:r.conteudo.length>60?r.conteudo.slice(0,60)+'...':r.conteudo,status:r.status||'Validado',sincronizado:r.sincronizado||r.modo==='real',modo:r.modo,turma:r.turma,disciplina:r.disciplina,observacoes:r.observacoes}; }).sort((a,b)=> b.data.localeCompare(a.data)); }
import { calcularProgresso } from './calendarService.js';
export function getEstadoReplica(){ const regs=loadRegistros(); const prog=calcularProgresso(regs);
  // Calcula distribuição real por mês a partir dos registros (fiel ao EduGestão)
  const mesesOrdem=['Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
  const mesNumParaLabel={2:'Fev',3:'Mar',4:'Abr',5:'Mai',6:'Jun',7:'Jul',8:'Ago',9:'Set',10:'Out',11:'Nov',12:'Dez'};
  const porDiscMes={};
  for(const r of regs){
    const disc=r.disciplina; if(!porDiscMes[disc]) porDiscMes[disc]={Fev:0,Mar:0,Abr:0,Mai:0,Jun:0,Jul:0,Ago:0,Set:0,Out:0,Nov:0,Dez:0};
    const m=parseInt(r.data.slice(5,7),10); const label=mesNumParaLabel[m]; if(label) porDiscMes[disc][label]+=(r.quantidadeAulas||r.aulas||1);
  }
  const tabela=prog.linhas.map(l=>{
    const mesesReais=porDiscMes[l.disciplina]||{Fev:0,Mar:0,Abr:0,Mai:0,Jun:0,Jul:0,Ago:0,Set:0,Out:0,Nov:0,Dez:0};
    // Se não há dados reais ainda (ex: instalação limpa), mantém zeros
    return {disciplina:l.disciplina,meses:{...mesesReais,totalReal:l.realizado,totalMeta:l.meta},progresso:l.percentual,status:l.status};
  });
  const totalAulas=regs.reduce((s,r)=>s+(r.quantidadeAulas||r.aulas||1),0);
  return {progressoGeral:prog.progressoGeral,totalRegistros:regs.length,totalAulas,totalMeta:prog.totalMeta,totalRealizado:prog.totalRealizado,tabela,registros:formatarParaReplica(regs),sincronizado:regs.filter(r=>r.modo==='real').length>0,ultimoSync:loadSyncLog()[0]||null};
}
export async function sincronizarComEduGestao({cpf,senha,headless=true}={}){ const {EduGestaoClient}=await import('./edugestaoClient.js'); const client=new EduGestaoClient({cpf,senha,headless}); const inicio=Date.now(); try{ await client.login(); const turmas=await client.getTurmasEDisciplinas(); let registrosReais=[]; try{ registrosReais=await client.getRegistrosReais(); }catch{} const duracao=Date.now()-inicio; const resultado={sucesso:true,duracaoMs:duracao,turmas:turmas.turmas?.length||0,disciplinas:turmas.disciplinas?.length||0,registrosReais:registrosReais.length,mensagem:`Sincronizado! ${registrosReais.length} registros encontrados`}; appendSyncLog({tipo:'sincronizar',...resultado}); await client.close(); return resultado; }catch(e){ const resultado={sucesso:false,erro:e.message,duracaoMs:Date.now()-inicio}; appendSyncLog({tipo:'sincronizar',...resultado}); try{ await client.close(); }catch{} throw e; } }
