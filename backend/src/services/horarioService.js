import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PATH_HORARIO = path.join(__dirname, '../config/horario.json');
export function getHorario(){ return JSON.parse(fs.readFileSync(PATH_HORARIO,'utf-8')); }
export function saveHorario(novo){ fs.writeFileSync(PATH_HORARIO, JSON.stringify(novo,null,2),'utf-8'); return novo; }
export function updateHorarioDia(diaKey,materias){ const h=getHorario(); h.horario_semanal[diaKey]=materias; saveHorario(h); return h; }
