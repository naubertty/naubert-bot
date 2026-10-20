/**
 * Cliente direto Supabase para Lago Verde - EduGestão
 * Descoberto via HAR do usuário: base Supabase, 6 disciplinas, 200 dias letivos
 * Uso: leitura fiel (sem Playwright) e escrita quando houver JWT
 */
const SUPABASE_URL = 'https://karcvuoiujwuivwvbfyl.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImthcmN2dW9pdWp3dWl2d3ZiZnlsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjgyMzMwMTIsImV4cCI6MjA4MzgwOTAxMn0.RyBoxqKWkfuJbZKoQDpBmRUhwPWlcfnEKLqyUBC5stg';
const TENANT_ID = '329c1841-0439-4019-bce5-4eee4e86ad79';
const CLASS_ID_DEFAULT = 'f414c4c3-97fc-4baa-8389-05d378249036'; // 1º ANO A MATUTINO
const TEACHER_ID_DEFAULT = 'a6fa5e6c-b5e1-4f6f-8e98-710e422929ea';
const SCHOOL_ID_DEFAULT = '09bbc165-0126-421a-ac84-0499561f33a3'; // U I PEDRO MARTINS FILHO
const CALENDAR_ID = '1de4ca83-30fc-49f8-b520-29c7a401598c';

export const SUBJECTS = {
  'Arte': '4afbdce9-7fc2-4ece-87f5-fb177e514e13',
  'Ciências': '93d9ae8c-d04a-4cae-83ea-559c9fca58e8',
  'Educação Física': '03dd6769-c35a-4352-843a-70ea9ebb5ab3',
  'Ensino Religioso': '18256701-c066-4e89-9826-c50b9226134b',
  'Língua Portuguesa': '11c25fb1-b9e4-4cd8-9464-fe7611effe83',
  'Matemática': '1ce1bbaa-2a10-48be-b683-0474b76048c8',
};
export const SUBJECT_IDS_INVERTED = Object.fromEntries(Object.entries(SUBJECTS).map(([k,v])=>[v,k]));

function headers(jwt){
  const h = {
    'apikey': SUPABASE_ANON_KEY,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
  if(jwt) h['Authorization'] = `Bearer ${jwt}`;
  return h;
}

export async function supabaseGet(path, jwt){
  const url = `${SUPABASE_URL}${path}`;
  const res = await fetch(url, { headers: headers(jwt) });
  if(!res.ok){
    const txt = await res.text();
    throw new Error(`Supabase GET ${path} ${res.status}: ${txt}`);
  }
  return res.json();
}

export async function supabasePost(path, body, jwt){
  const url = `${SUPABASE_URL}${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...headers(jwt), 'Prefer': 'return=representation' },
    body: JSON.stringify(body)
  });
  if(!res.ok){
    const txt = await res.text();
    throw new Error(`Supabase POST ${path} ${res.status}: ${txt}`);
  }
  return res.json();
}

export async function getDiaryEntries({ class_id=CLASS_ID_DEFAULT, teacher_id=TEACHER_ID_DEFAULT, subject_id, jwt }={}){
  let q = `/rest/v1/diary_entries?select=*%2Csubjects(name)%2Cclasses(name%2Cgrade%2Cshift)&class_id=eq.${class_id}&teacher_id=eq.${teacher_id}&is_active=eq.true&order=entry_date.desc`;
  if(subject_id) q += `&subject_id=eq.${subject_id}`;
  return supabaseGet(q, jwt);
}

export async function getDiaryEntriesAggregated({ class_id=CLASS_ID_DEFAULT, teacher_id=TEACHER_ID_DEFAULT, jwt }={}){
  const q = `/rest/v1/diary_entries?select=id%2Csubject_id%2Centry_date%2Clesson_count&class_id=eq.${class_id}&teacher_id=eq.${teacher_id}&is_active=eq.true&order=id.asc&limit=1000&offset=0`;
  return supabaseGet(q, jwt);
}

export async function getClassTeachers({ class_id=CLASS_ID_DEFAULT, teacher_id=TEACHER_ID_DEFAULT, jwt }={}){
  const q = `/rest/v1/class_teachers?select=subject_id%2Cweekly_hours&class_id=eq.${class_id}&teacher_id=eq.${teacher_id}&is_active=eq.true`;
  return supabaseGet(q, jwt);
}

export async function getCalendarBimesters({ calendar_id=CALENDAR_ID, jwt }={}){
  const q = `/rest/v1/calendar_bimester_periods?select=*&calendar_id=eq.${calendar_id}&order=bimester.asc`;
  return supabaseGet(q, jwt);
}

/**
 * Cria registro no Diário. Requer JWT válido (capturado após login via Playwright ou via Supabase Auth).
 * Campos conforme HAR: teacher_id, class_id, subject_id, school_id, entry_date, weekday, lesson_count, content, observations, tenant_id
 */
export async function createDiaryEntry({ class_id, subject_id, teacher_id, school_id, entry_date, weekday, lesson_count, content, observations, is_saturday=false, jwt }){
  if(!jwt) throw new Error('JWT necessário para escrita no Supabase. Faça login localmente primeiro.');
  const payload = {
    teacher_id: teacher_id || TEACHER_ID_DEFAULT,
    class_id: class_id || CLASS_ID_DEFAULT,
    subject_id,
    school_id: school_id || SCHOOL_ID_DEFAULT,
    entry_date,
    weekday,
    lesson_count,
    content,
    observations: observations || '',
    is_saturday,
    is_active: true,
    validation_status: 'approved',
    tenant_id: TENANT_ID,
  };
  return supabasePost('/rest/v1/diary_entries', payload, jwt);
}

export function weekdayLabel(dateISO){
  const d=new Date(dateISO+'T12:00:00'); const map=['Domingo','Segunda-feira','Terça-feira','Quarta-feira','Quinta-feira','Sexta-feira','Sábado']; return map[d.getDay()];
}
export function weekdayKey(dateISO){
  const d=new Date(dateISO+'T12:00:00'); const map=['domingo','segunda','terca','quarta','quinta','sexta','sabado']; return map[d.getDay()];
}

export const CONFIG = { SUPABASE_URL, SUPABASE_ANON_KEY, TENANT_ID, CLASS_ID_DEFAULT, TEACHER_ID_DEFAULT, SCHOOL_ID_DEFAULT, CALENDAR_ID };
