import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
let conteudosCache=null;
function loadConteudos(){ if(conteudosCache) return conteudosCache; const p=path.join(__dirname,'../config/conteudos.json'); try{ conteudosCache=JSON.parse(fs.readFileSync(p,'utf-8')); }catch{ conteudosCache={"1º Ano":{Arte:{bimestre_1:["Exploração de cores primárias"],bimestre_2:["Modelagem com massa"],bimestre_3:["Arte africana"],bimestre_4:["Exposição"]},Ciências:{bimestre_1:["Corpo humano"],bimestre_2:["Água"],bimestre_3:["Saúde"],bimestre_4:["Universo"]},"Educação Física":{bimestre_1:["Brincadeiras"],bimestre_2:["Circuitos"],bimestre_3:["Esportes"],bimestre_4:["Gincana"]},"Ensino Religioso":{bimestre_1:["Identidade"],bimestre_2:["Tradições"],bimestre_3:["Ritos"],bimestre_4:["Solidariedade"]},"Língua Portuguesa":{bimestre_1:["Alfabeto"],bimestre_2:["Leitura compartilhada"],bimestre_3:["Receita"],bimestre_4:["Leitura fluente"]},Matemática:{bimestre_1:["Números 0 a 20"],bimestre_2:["Números até 50"],bimestre_3:["Números até 100"],bimestre_4:["Frações"]}}}; } return conteudosCache; }
export function getBimestre(dataISO){ const d=new Date(dataISO+'T12:00:00'); const m=d.getMonth()+1; const day=d.getDate(); if((m===2&&day>=2)||m===3||(m===4&&day<=17)) return 'bimestre_1'; if((m===4&&day>=22)||m===5||m===6||(m===7&&day<=3)) return 'bimestre_2'; if((m===7&&day>=21)||m===8||m===9) return 'bimestre_3'; return 'bimestre_4'; }
export function getBimestreLabel(b){ return {bimestre_1:'1º Bimestre',bimestre_2:'2º Bimestre',bimestre_3:'3º Bimestre',bimestre_4:'4º Bimestre'}[b]||b; }
export function gerarConteudo({disciplina,dataISO,ano='1º Ano',historico=[]}){
  const db=loadConteudos(); const bimestre=getBimestre(dataISO); const lista=db[ano]?.[disciplina]?.[bimestre];
  if(!lista||lista.length===0) return {conteudo:`Aula de ${disciplina} - BNCC ${ano} ${getBimestreLabel(bimestre)}`,bimestre:getBimestreLabel(bimestre),objetivo:`BNCC ${disciplina}`};
  const hash=[...dataISO+disciplina].reduce((a,c)=>a+c.charCodeAt(0),0); let idx=hash%lista.length; let tent=0;
  while(tent<lista.length){ const cand=lista[idx]; const rep=historico.slice(-6).includes(cand); if(!rep) break; idx=(idx+1)%lista.length; tent++; }
  const conteudo=lista[idx]; return {conteudo,bimestre:getBimestreLabel(bimestre),bimestre_key:bimestre,disciplina,data:dataISO,objetivo:conteudo.split(' - ')[0].trim()};
}
export function listarConteudosDisponiveis(disciplina,ano='1º Ano'){ const db=loadConteudos(); return db[ano]?.[disciplina]||null; }
export function gerarObservacao({disciplina}){
  const obs={'Arte':'Aula com participação ativa. Materiais em grupos.','Ciências':'Atividade prática com registro no caderno.','Educação Física':'Atividade na quadra com alongamento.','Ensino Religioso':'Roda de conversa com respeito.','Língua Portuguesa':'Leitura deleite e registro no caderno.','Matemática':'Material concreto e correção coletiva.'};
  return obs[disciplina]||'';
}
