import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getCalendarioCompleto, isDiaLetivo, getHorarioDoDia, getBimestreLabel } from './calendarService.js';
import { gerarConteudo, gerarObservacao } from './contentGenerator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '../../../data');
const REGISTROS_PATH = path.join(DATA_DIR, 'registros.json');

function loadRegistros(){ try{ return JSON.parse(fs.readFileSync(REGISTROS_PATH,'utf-8')); }catch{ return []; } }
function saveRegistros(r){ fs.writeFileSync(REGISTROS_PATH, JSON.stringify(r,null,2)); }

/**
 * Varredura completa: analisa o que já existe (local ou Supabase) e cria o que falta até a data atual
 * - Usa calendário oficial (200 dias) para saber dias letivos
 * - Usa horário da turma para saber quantas aulas por dia
 * - Usa supabaseClient se conseguir, senão usa local
 */
export async function varreduraCompleta({ cpf, senha, ateDataISO, modo='real', dryRun=false }={}){
  const hoje = ateDataISO || new Date().toISOString().slice(0,10);
  const inicioAno = '2026-02-09'; // início 1º bimestre oficial
  const logs = [];
  const criados = [];
  const jaExistiam = [];
  const puladosNaoLetivo = [];

  // tenta buscar registros reais do Supabase se logado
  let registrosOriginais = loadRegistros();
  let origem = 'local';
  if(cpf && senha){
    try{
      // tenta login via Playwright para pegar dados reais e também JWT
      const { EduGestaoClient } = await import('./edugestaoClient.js');
      const client = new EduGestaoClient({ cpf, senha, headless: true });
      await client.login();
      const reais = await client.getRegistrosReais().catch(()=>[]);
      if(reais && reais.length){
        logs.push(`Supabase/Playwright: ${reais.length} registros encontrados no oficial`);
        // converte formato do edugestaoClient para nosso formato se necessário
        // se já vier no formato esperado, usa direto
        // senão mantém local
        if(reais[0]?.data) registrosOriginais = reais;
        origem = 'oficial';
      } else {
        logs.push('Oficial sem retorno, usando local');
      }
      await client.close();
    }catch(e){
      logs.push(`Aviso login oficial falhou (${e.message}), usando local. Rode LOCALMENTE se estiver no preview.`);
    }
  }

  // índice de já existentes por data+disciplina
  const idx = new Set(registrosOriginais.map(r=> `${r.data}::${r.disciplina}`));
  const calendario = getCalendarioCompleto(2026);

  // Determina início da varredura: dia seguinte ao último registro existente (ou inicioAno se vazio)
  let dataInicio = inicioAno;
  if(registrosOriginais.length){
    const maxData = registrosOriginais.reduce((max,r)=> r.data > max ? r.data : max, registrosOriginais[0].data);
    const d = new Date(maxData+'T12:00:00'); d.setDate(d.getDate()+1);
    dataInicio = d.toISOString().slice(0,10);
    logs.push(`Último registro existente: ${maxData} → varredura a partir de ${dataInicio}`);
  }
  // Itera dia a dia
  let cur = new Date(dataInicio+'T12:00:00');
  const fim = new Date(hoje+'T12:00:00');
  while(cur <= fim){
    const iso = cur.toISOString().slice(0,10);
    const letivo = isDiaLetivo(iso);
    if(!letivo){
      puladosNaoLetivo.push(iso);
      cur.setDate(cur.getDate()+1);
      continue;
    }
    const materias = getHorarioDoDia(iso);
    if(materias.length===0){
      cur.setDate(cur.getDate()+1);
      continue;
    }
    for(const m of materias){
      const key = `${iso}::${m.disciplina}`;
      if(idx.has(key)){
        jaExistiam.push({ data: iso, disciplina: m.disciplina, status: 'ja_existe' });
        continue;
      }
      // falta - criar
      const historico = registrosOriginais.filter(r=> r.disciplina===m.disciplina).map(r=> r.conteudo);
      const gen = gerarConteudo({ disciplina: m.disciplina, dataISO: iso, historico });
      const novo = {
        id: `varredura-${iso}-${m.disciplina.replace(/\s/g,'_')}-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
        turma: '1º ANO A MATUTINO - 1º Ano (U I PEDRO MARTINS FILHO)',
        disciplina: m.disciplina,
        data: iso,
        quantidadeAulas: m.aulas,
        conteudo: gen.conteudo,
        observacoes: gerarObservacao({ disciplina: m.disciplina }),
        bimestre: gen.bimestre,
        status: 'Validado',
        criadoEm: new Date().toISOString(),
        modo,
        sincronizado: modo==='real',
        origem: `varredura-${origem}`
      };
      if(!dryRun){
        registrosOriginais.push(novo);
        idx.add(key);
        // tenta gravar no Supabase se modo real e tiver CPF
        if(modo==='real' && cpf){
          try{
            const { SUBJECTS, createDiaryEntry, weekdayLabel } = await import('./supabaseClient.js');
            const subject_id = SUBJECTS[m.disciplina];
            if(subject_id){
              // tenta pegar JWT da sessão
              let jwt=null;
              try{
                const p=path.join(DATA_DIR, `session-${cpf}.json`);
                if(fs.existsSync(p)){ const s=JSON.parse(fs.readFileSync(p,'utf-8')); jwt=s.jwt||s.access_token||null; }
              }catch{}
              try{
                await createDiaryEntry({ subject_id, entry_date: iso, weekday: weekdayLabel(iso), lesson_count: m.aulas, content: gen.conteudo, observations: novo.observacoes, jwt });
                logs.push(`✓ ${iso} ${m.disciplina} ${m.aulas}a → Supabase OK`);
              }catch(eSupa){
                logs.push(`⚠ ${iso} ${m.disciplina}: Supabase sem JWT (${eSupa.message}) - salvo só local (otimista)`);
              }
            }
          }catch(e){}
        }
      }
      criados.push(novo);
    }
    cur.setDate(cur.getDate()+1);
  }

  if(!dryRun && criados.length){
    saveRegistros(registrosOriginais);
  }

  return {
    ok: true,
    ateData: hoje,
    origem,
    totalAnterior: loadRegistros().length - (dryRun?0:criados.length),
    totalAulasAnterior: registrosOriginais.reduce((s,r)=>s+(r.quantidadeAulas||1),0) - criados.reduce((s,r)=>s+(r.quantidadeAulas||1),0),
    criados: criados.length,
    criadosDetalhe: criados.slice(0,50),
    jaExistiam: jaExistiam.length,
    puladosNaoLetivo: puladosNaoLetivo.length,
    totalFinal: registrosOriginais.length,
    logs,
    modo,
    dryRun
  };
}
