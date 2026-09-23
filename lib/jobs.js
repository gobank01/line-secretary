// งานที่ต้องทำเป็นรอบ — ใช้ร่วมกันทั้ง Railway worker และ Vercel cron
import { q, save } from './db.js';
import { summarize, extractOrders, dueTime, salesReport, bkkDate, addDays } from './brain.js';
import { push, groupTitle, memberName, pushQuotaLeft, tokenDaysLeft } from './line.js';
import { agenda, agendaText, hasCalendar } from './calendar.js';
import { events, hasGoogle } from './google.js';

const MAX_PER_REPORT = 500; // ponytail: กันกลุ่มที่ระเบิดข้อความไม่ให้ยิง token ทีเดียวเป็นแสน
const MAX_PUSH_CHARS = 4500; // LINE ตัดทิ้งที่ 5000 — เผื่อหัวกับลิงก์ท้ายไว้
const QUESTION = /\?|ไหม|มั้ย|หรือเปล่า|รึเปล่า|เท่าไ|กี่|เมื่อไ|ยังไง|อย่างไร|ขอถาม|สอบถาม/;

const hourBangkok = () =>
  Number(new Date().toLocaleString('en-US', { timeZone: 'Asia/Bangkok', hour: '2-digit', hour12: false }));

const thaiTime = () =>
  new Date().toLocaleString('th-TH', {
    timeZone: 'Asia/Bangkok', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });

// ลิงก์กระดานไว้แปะท้ายรายงาน — Vercel ใส่ VERCEL_PROJECT_PRODUCTION_URL ให้เอง ไม่ต้องตั้งเพิ่ม
function dashUrl() {
  const base =
    process.env.DASHBOARD_URL ||
    (process.env.VERCEL_PROJECT_PRODUCTION_URL && `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`);
  if (!base) return '';
  const key = process.env.DASHBOARD_PUBLIC === '1' || !process.env.DASHBOARD_KEY
    ? '' : `?key=${process.env.DASHBOARD_KEY}`;
  return `${base.replace(/\/$/, '')}/dashboard${key}`;
}

// force = ไม่สนใจว่าถึงชั่วโมงรายงานหรือยัง (โหมด Vercel cron ที่รันได้วันละครั้ง)
export async function report({ force = false } = {}) {
  // ไม่บังคับว่าต้องมี report_to — ยังไม่ตั้ง OWNER_USER_ID ก็ยังอยากให้สรุปขึ้น dashboard
  const { rows: groups } = force
    ? await q(`select * from watched where active`)
    : await q(
        `select * from watched
          where active and $1 = any(report_hours)
            and (last_report_at is null or last_report_at < now() - interval '2 hours')`,
        [hourBangkok()]
      );

  // รวมทุกกลุ่มเป็นข้อความเดียวต่อคนรับ — ยิงแยกทีละกลุ่มกินโควตาฟรี (300/เดือน) หมดตั้งแต่ 5 กลุ่ม
  const digest = new Map();
  let sent = 0;
  let failed = 0;

  const one = async (g) => {
    try {
      const { rows } = await q(
        `select id, user_id, text, ts from messages
          where source_id = $1 and processed_at is null and text is not null
          order by ts limit $2`,
        [g.source_id, MAX_PER_REPORT]
      );

      // ไม่มีอะไรใหม่ก็ไม่ต้องกวน (และไม่เปลืองโควตา push)
      if (rows.length === 0) {
        return q('update watched set last_report_at = now() where source_id = $1', [g.source_id]);
      }

      // กลุ่มเก่าที่ยังไม่มีชื่อ (เชิญเข้ามาก่อนเวอร์ชันนี้) — เติมให้ตอนสรุปรอบแรก
      let title = g.title;
      if (!title) {
        title = await groupTitle('group', g.source_id);
        if (title) await q('update watched set title = $2 where source_id = $1', [g.source_id, title]);
      }

      const summary = await summarize(title, await withNames(g.source_id, rows));
      const period = { start: rows[0].ts, end: rows.at(-1).ts };
      const orderLine = g.track_orders ? (await saveOrders(g.source_id, rows)) + (await moneyLine(g)) : '';

      // ลง dashboard ก่อน แล้วค่อย push — push มีโควตา ถ้าพลาดสรุปต้องไม่หาย
      await q('insert into reports (source_id, period_start, period_end, summary) values ($1,$2,$3,$4)', [
        g.source_id, period.start, period.end, summary,
      ]);

      if (g.report_to) {
        const block = `📋 ${title || g.source_id.slice(0, 8)} (${rows.length} ข้อความ)\n${summary}${orderLine}`;
        digest.set(g.report_to, [...(digest.get(g.report_to) || []), block]);
      }
      // mark เฉพาะช่วงที่สรุปไปแล้ว — ข้อความที่เข้ามาระหว่างสรุปจะไปโผล่รอบหน้า
      await q(
        `update messages set processed_at = now()
          where source_id = $1 and processed_at is null and ts <= $2`,
        [g.source_id, period.end]
      );
      await q('update watched set last_report_at = now() where source_id = $1', [g.source_id]);
      sent++;
    } catch (err) {
      // ไม่ได้มาร์คว่าสรุปแล้ว → ข้อความยังอยู่ รอบหน้าสรุปใหม่ ไม่มีอะไรหาย
      failed++;
      console.error(`report failed ${g.source_id}:`, err.message);
    }
  };

  // สรุปทีละ 4 กลุ่มพร้อมกัน — กลุ่มหนึ่งใช้เวลา ~20 วินาที ถ้าไล่ทีละกลุ่มจะชนเพดาน 300 วินาทีตั้งแต่ 15 กลุ่ม
  for (let i = 0; i < groups.length; i += 4) await Promise.all(groups.slice(i, i + 4).map(one));

  const plans = digest.size ? await agendaLine() : '';
  for (const [to, blocks] of digest) await push(to, digestText(blocks, dashUrl(), plans));
  return { sent, failed };
}

// ต่อบล็อกสรุปเป็นข้อความเดียว ยาวเกินก็ตัด แล้วบอกให้ไปอ่านต่อบนกระดาน (ไม่ปล่อยให้ LINE ตัดเงียบ ๆ)
export function digestText(blocks, link = dashUrl(), plans = '') {
  const head = `📊 สรุปรอบ ${thaiTime()} น. · ${blocks.length} กลุ่ม${plans}`;
  const tail = link ? `\n\nอ่านเต็ม ๆ ที่ ${link}` : '';
  const sep = '\n\n───────\n\n';
  const out = [];
  let len = head.length + tail.length;

  for (const b of blocks) {
    if (len + b.length + sep.length > MAX_PUSH_CHARS) {
      out.push(`…อีก ${blocks.length - out.length} กลุ่ม อ่านบนกระดาน`);
      break;
    }
    out.push(b);
    len += b.length + sep.length;
  }
  return `${head}\n\n${out.join(sep)}${tail}`;
}

// เติมชื่อคนพูดให้แต่ละข้อความ — ถาม LINE ครั้งเดียวต่อคน แล้วจำไว้ในตาราง people
async function withNames(sourceId, rows) {
  const ids = [...new Set(rows.map((r) => r.user_id).filter(Boolean))];
  if (!ids.length) return rows;

  const { rows: known } = await q('select user_id, name from people where user_id = any($1)', [ids]);
  const names = new Map(known.map((p) => [p.user_id, p.name]));

  for (const id of ids) {
    if (names.has(id)) continue; // เคยถามแล้ว (ได้ null ก็นับว่าถามแล้ว)
    const name = await memberName(sourceId.startsWith('R') ? 'room' : 'group', sourceId, id);
    await q(
      `insert into people (user_id, name) values ($1,$2)
       on conflict (user_id) do update set name = coalesce(excluded.name, people.name), updated_at = now()`,
      [id, name]
    );
    names.set(id, name);
  }
  return rows.map((r) => ({ ...r, who: names.get(r.user_id) || null }));
}

async function saveOrders(sourceId, rows) {
  const found = await extractOrders(rows);
  let total = 0;
  for (const o of found) {
    const src = rows[o.i];
    if (!src) continue;
    total += Number(o.amount) || 0;
    await q(
      `insert into orders (source_id, customer, items, amount, ordered_at, source_message_id)
       values ($1,$2,$3,$4,$5,$6) on conflict (source_message_id) do nothing`,
      [sourceId, o.customer || null, JSON.stringify(o.items || []), o.amount || null, src.ts, src.id]
    );
  }
  if (!found.length) return '';
  return `\n\n🧾 ออเดอร์ ${found.length} รายการ${total ? ` · รวม ${total.toLocaleString('th-TH')} บาท` : ''}`;
}

// รายงานเช้าแปะนัดวันนี้ · รายงานเย็นแปะนัดพรุ่งนี้ (ไม่ได้ต่อปฏิทินก็ข้ามไป)
async function agendaLine() {
  if (!hasCalendar() && !hasGoogle()) return '';
  const morning = hourBangkok() < 12;
  const opts = { days: 1, skip: morning ? 0 : 1 };
  try {
    const list = (await events(opts)) ?? (await agenda(opts));
    return list?.length ? `\n\n${agendaText(list, morning ? 'วันนี้' : 'พรุ่งนี้')}` : '';
  } catch (err) {
    console.error('agenda failed:', err.message);
    return '';
  }
}

// เงินเข้าจากสลิปในกลุ่ม นับตั้งแต่รายงานรอบที่แล้ว
async function moneyLine(g) {
  const { rows: [p] } = await q(
    `select count(*)::int as n, coalesce(sum(amount),0) as total,
            count(*) filter (where matched_order_id is not null)::int as matched
       from payments
      where source_id = $1 and created_at > coalesce($2::timestamptz, now() - interval '24 hours')`,
    [g.source_id, g.last_report_at]
  );
  if (!p.n) return '';
  return (
    `\n\n💰 เงินเข้า ${p.n} ใบ · รวม ${Number(p.total).toLocaleString('th-TH')} บาท` +
    (p.matched ? ` · ตรงกับออเดอร์ ${p.matched} รายการ` : '')
  );
}

// ลูกค้าถามค้างไว้ — ข้อความล่าสุดของกลุ่มเป็นคำถาม และไม่มีใครพิมพ์ต่อเกินเวลาที่ตั้งไว้
// ponytail: ดูแค่ข้อความล่าสุดพอ ถ้าจะแยกว่าใครเป็นทีมงาน ต้องเก็บรายชื่อ staff ต่อกลุ่มเพิ่ม
export async function checkSla() {
  const { rows } = await q(
    `select distinct on (w.source_id)
            w.source_id, w.title, w.report_to, w.sla_minutes,
            m.line_message_id, m.text, m.ts
       from watched w join messages m on m.source_id = w.source_id
      where w.active and w.report_to is not null and w.sla_minutes > 0 and m.text is not null
      order by w.source_id, m.ts desc`
  );

  let sent = 0;
  for (const r of rows) {
    const waited = (Date.now() - new Date(r.ts)) / 60000;
    if (waited < r.sla_minutes || waited > 24 * 60) continue; // เก่าเกินวันแล้วช่างมัน
    if (!QUESTION.test(r.text)) continue;

    const { rowCount } = await q(
      `insert into alerts (source_id, kind, ref) values ($1,'sla',$2) on conflict do nothing`,
      [r.source_id, r.line_message_id]
    );
    if (!rowCount) continue; // เตือนไปแล้ว

    await push(
      r.report_to,
      `⏰ กลุ่ม ${r.title || r.source_id.slice(0, 8)} มีคำถามค้าง ${Math.round(waited)} นาที ยังไม่มีใครตอบ\n\n"${r.text.slice(0, 300)}"`
    );
    sent++;
  }
  return sent;
}

// งานที่ถึงกำหนดแล้ว — add_todo เก็บ due ไว้ ต้องมีคนมาอ่านไม่งั้น "เตือนพรุ่งนี้ 10 โมง" คือจดแล้วเงียบ
export async function checkDue() {
  const { rows } = await q(`select source_id, data from state where jsonb_array_length(data->'todos') > 0`);
  const now = Date.now();
  let sent = 0;

  for (const r of rows) {
    const todos = r.data?.todos || [];
    const hit = todos.filter((t) => !t.done && !t.notified && dueTime(t.due)?.getTime() <= now);
    if (!hit.length) continue;

    // งานที่จดในกลุ่ม ก็เตือนเข้าแชทส่วนตัวเจ้าของ
    const to = r.source_id.startsWith('U') ? r.source_id : process.env.OWNER_USER_ID;
    if (!to) continue;

    const ok = await push(
      to,
      `⏰ ถึงกำหนดแล้ว ${hit.length} งาน\n\n` +
        hit.map((t) => `#${t.id} ${t.text}${t.due ? ` (${t.due})` : ''}`).join('\n') +
        `\n\nทำเสร็จแล้วพิมพ์ "ปิดงาน ${hit[0].id}"`
    );
    if (!ok) continue; // push ไม่ผ่าน = ยังไม่มาร์ค ไว้เตือนรอบหน้า

    for (const t of hit) t.notified = true;
    await save(r.source_id, r.data);
    sent += hit.length;
  }
  return sent;
}

// บอทตายเงียบคือฝันร้าย — เช็คของที่ทำให้ตายได้ แล้วเตือนเจ้าของก่อนพัง (วันละครั้งต่อเรื่อง)
export async function checkHealth({ notify = true } = {}) {
  // โหมดที่เปิดอยู่ — เวลาสงสัยว่า "ทำไมบอทไม่ทัก/ไม่ตอบ" ดูตรงนี้ก่อน จะได้ไม่ต้องไปงมใน env
  const checks = {
    mode: {
      silent_join: process.env.SILENT_JOIN === '1',
      reply_to_all: process.env.REPLY_TO_ALL === '1',
      dashboard_public: process.env.DASHBOARD_PUBLIC === '1',
      cron_frequent: process.env.CRON_FREQUENT === '1',
      auto_token: !!(process.env.LINE_CHANNEL_ID && process.env.LINE_CHANNEL_SECRET),
      calendar: hasCalendar() || hasGoogle(),
      google: hasGoogle(),
    },
  };
  const problems = [];

  try {
    await q('select 1');
    checks.db = 'ok';
  } catch (err) {
    checks.db = err.message;
    problems.push(['db', `ต่อฐานข้อมูลไม่ได้: ${err.message}`]);
  }

  const days = await tokenDaysLeft();
  checks.token_days = days;
  // ต่ออายุเองได้ = เตือนต่อเมื่อระบบต่อไม่สำเร็จจริง ๆ (ปกติจะออกใหม่ตั้งแต่เหลือ 2 วัน)
  if (days !== null && days <= (checks.mode.auto_token ? 1 : 7))
    problems.push([
      'token',
      checks.mode.auto_token
        ? `LINE token เหลือ ${days} วัน และต่ออายุอัตโนมัติไม่สำเร็จ — เช็ค LINE_CHANNEL_ID/SECRET`
        : `LINE token เหลือ ${days} วันจะหมดอายุ — ออกใหม่ก่อนบอทเงียบ`,
    ]);

  const left = await pushQuotaLeft();
  checks.push_left = left === Infinity ? 'unlimited' : left;
  if (typeof left === 'number' && left < 30)
    problems.push(['quota', `โควตา push เหลือ ${left} ข้อความในเดือนนี้ (แผนฟรีให้ 300)`]);

  const ai = await openrouterOk();
  checks.openrouter = ai.ok ? 'ok' : ai.error;
  if (!ai.ok) problems.push(['ai', `เรียก AI ไม่ได้: ${ai.error}`]);

  // เคยสรุปได้แล้วอยู่ ๆ หยุดไปเกินวัน = cron ตาย (กลุ่มใหม่ที่ยังไม่เคยสรุปไม่นับ)
  const { rows: [stale] } = await q(
    `select count(*)::int as n from watched
      where active and last_report_at is not null and last_report_at < now() - interval '26 hours'`
  );
  checks.stale_groups = stale.n;
  if (stale.n) problems.push(['cron', `${stale.n} กลุ่มไม่ได้สรุปมาเกินวันแล้ว — cron อาจไม่ทำงาน`]);

  if (notify && process.env.OWNER_USER_ID) {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
    for (const [key, text] of problems) {
      // เรื่องเดิมเตือนวันละครั้งพอ
      const { rowCount } = await q(
        `insert into alerts (source_id, kind, ref, detail) values ('system','health',$1,$2)
         on conflict do nothing`,
        [`${today}:${key}`, text]
      );
      if (rowCount) await push(process.env.OWNER_USER_ID, `🩺 ระบบเลขามีปัญหา\n\n${text}`);
    }
  }

  return { ok: !problems.length, checks, problems: problems.map(([, text]) => text) };
}

// เช็คว่า key ยังใช้ได้/ยังมีเครดิต โดยไม่ต้องเผา token ถามโมเดลจริง
async function openrouterOk() {
  if (!process.env.OPENROUTER_API_KEY) return { ok: false, error: 'ยังไม่ได้ตั้ง OPENROUTER_API_KEY' };
  try {
    const res = await fetch('https://openrouter.ai/api/v1/key', {
      headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` },
    });
    if (!res.ok) return { ok: false, error: `openrouter ${res.status}` };
    const { data } = await res.json();
    if (data?.limit != null && data.limit - (data.usage ?? 0) <= 0) return { ok: false, error: 'เครดิตหมด' };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ทุกวันจันทร์ ส่งสรุปยอดขาย 7 วันที่แล้ว (จันทร์–อาทิตย์) ให้เจ้าของ
// cron ยิงซ้ำ/กดเองกี่รอบก็ส่งครั้งเดียว — จองสิทธิ์ในตาราง alerts ก่อนส่ง
async function weeklySales() {
  const owner = process.env.OWNER_USER_ID;
  const weekday = new Date().toLocaleDateString('en-US', { timeZone: 'Asia/Bangkok', weekday: 'short' });
  if (!owner || weekday !== 'Mon') return 0;

  const end = addDays(bkkDate(), -1);
  const { rowCount } = await q(
    `insert into alerts (source_id, kind, ref) values ($1, 'sales_week', $2) on conflict do nothing`,
    [owner, end]
  );
  if (!rowCount) return 0;

  const text = await salesReport(owner, { days: 7, end_date: end });
  if (text.startsWith('ยังไม่มียอด')) return 0;
  if (await push(owner, `📊 สรุปยอดขายสัปดาห์ที่แล้ว\n\n${text}`)) return 1;
  // ส่งไม่ออก = คืนสิทธิ์ รอบหน้าลองใหม่
  await q(`delete from alerts where kind = 'sales_week' and ref = $1`, [end]);
  return 0;
}

export async function runJobs(opts = {}) {
  const { sent, failed } = await report(opts);
  const alerted = await checkSla();
  const due = await checkDue();
  const sales = await weeklySales();
  // เช็คสุขภาพวันละครั้งพอ (เช้า 9 โมง) — ยิงถี่กว่านั้นก็ได้คำตอบเดิม
  const health = opts.force || hourBangkok() === 9 ? await checkHealth() : null;
  return {
    reported: sent,
    ...(failed && { failed }), // สรุปไม่สำเร็จกี่กลุ่ม (ข้อความยังอยู่ รอบหน้าลองใหม่)
    alerted,
    due,
    ...(sales && { sales }),
    ...(health && { problems: health.problems }),
  };
}
