import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
let calendarioCache=null, horarioCache=null;
function loadCalendario(){ if(calendarioCache) return calendarioCache; const p=path.join(__dirname,'../config/calendario2026.json'); calendarioCache=JSON.parse(fs.readFileSync(p,'utf-8')); return calendarioCache; }
function loadHorario(){ if(horarioCache) return horarioCache; const p=path.join(__dirname,'../config/horario.json'); horarioCache=JSON.parse(fs.readFileSync(p,'utf-8')); return horarioCache; }
export function isDiaLetivo(dataISO){
  const cal=loadCalendario(); const d=new Date(dataISO+'T12:00:00'); const dow=d.getDay(); if(dow===0||dow===6) return false;
  const feriado=cal.feriados_e_recessos.find(f=> f.data===dataISO); if(feriado && feriado.letivo===false) return false;
  for(const f of cal.feriados_e_recessos){ if(f.periodo){ const [ini,fim]=f.periodo.split(' a '); if(dataISO>=ini && dataISO<=fim) return false; } }
  if(dataISO<'2026-02-02'||dataISO>'2026-12-18') return false; return true;
}
export function getDiaSemanaKey(dataISO){ const d=new Date(dataISO+'T12:00:00'); const map=['domingo','segunda','terca','quarta','quinta','sexta','sabado']; return map[d.getDay()]; }
export function getHorarioDoDia(dataISO){ const horario=loadHorario(); const key=getDiaSemanaKey(dataISO); if(!isDiaLetivo(dataISO)) return []; return horario.horario_semanal[key]||[]; }
export function getCalendarioCompleto(ano=2026){
  const cal=loadCalendario(); const horario=loadHorario(); const dias=[]; const start=new Date(`${ano}-02-02T12:00:00`); const end=new Date(`${ano}-12-18T12:00:00`);
  for(let d=new Date(start); d<=end; d.setDate(d.getDate()+1)){ const iso=d.toISOString().slice(0,10); const letivo=isDiaLetivo(iso); const diaSemana=getDiaSemanaKey(iso); const materias=letivo?getHorarioDoDia(iso):[]; dias.push({data:iso,diaSemana,diaSemanaLabel:labelDiaSemana(diaSemana),letivo,materias,totalAulas:materias.reduce((s,m)=>s+m.aulas,0),bimestre:getBimestreLabel(iso)}); }
  return {ano,dias,calendario:cal,horario:horario,totalDiasLetivos:dias.filter(x=>x.letivo).length};
}
function labelDiaSemana(k){ return {segunda:'Segunda-feira',terca:'Terça-feira',quarta:'Quarta-feira',quinta:'Quinta-feira',sexta:'Sexta-feira',sabado:'Sábado',domingo:'Domingo'}[k]||k; }
export function getBimestreLabel(dataISO){ const d=new Date(dataISO+'T12:00:00'); const m=d.getMonth()+1; const day=d.getDate(); if((m===2&&day>=2)||m===3||(m===4&&day<=17)) return '1º Bim.'; if((m===4&&day>=22)||m===5||m===6||(m===7&&day<=3)) return '2º Bim.'; if((m===7&&day>=21)||m===8||m===9) return '3º Bim.'; return '4º Bim.'; }
export function getProximosDias(qtd=7,incluirHoje=true){
  const hoje=new Date(); hoje.setHours(12,0,0,0); const res=[]; let cur=new Date(hoje); if(!incluirHoje) cur.setDate(cur.getDate()+1);
  while(res.length<qtd){ const iso=cur.toISOString().slice(0,10); res.push({data:iso,...getDiaInfo(iso)}); cur.setDate(cur.getDate()+1); if(iso>'2026-12-18') break; } return res;
}
export function getDiaInfo(dataISO){ return {data:dataISO,letivo:isDiaLetivo(dataISO),diaSemanaKey:getDiaSemanaKey(dataISO),diaSemanaLabel:labelDiaSemana(getDiaSemanaKey(dataISO)),materias:getHorarioDoDia(dataISO),totalAulas:getHorarioDoDia(dataISO).reduce((s,m)=>s+m.aulas,0),bimestre:getBimestreLabel(dataISO),formatBR:formatBR(dataISO)}; }
function formatBR(iso){ const [y,m,d]=iso.split('-'); return `${d}/${m}/${y}`; }
export function calcularProgresso(registros=[]){
  const horario=loadHorario(); const metas=horario.metas_anuais_por_disciplina; const porDisciplina={}; for(const disc of Object.keys(metas)) porDisciplina[disc]=0;
  for(const r of registros){ if(porDisciplina[r.disciplina]!==undefined) porDisciplina[r.disciplina]+=(r.aulas||r.quantidadeAulas||1); }
  const linhas=Object.entries(metas).map(([disc,meta])=> ({disciplina:disc,realizado:porDisciplina[disc]||0,meta,percentual:Math.min(100,Math.round((porDisciplina[disc]/meta)*100)),status:porDisciplina[disc]>=meta?'meta':porDisciplina[disc]>=meta*0.5?'parcial':'baixo'}));
  const totalRealizado=Object.values(porDisciplina).reduce((a,b)=>a+b,0); const totalMeta=Object.values(metas).reduce((a,b)=>a+b,0); const progressoGeral=Math.round((totalRealizado/totalMeta)*100);
  return {porDisciplina,linhas,totalRealizado,totalMeta,progressoGeral};
}
