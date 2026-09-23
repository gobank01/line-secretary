// รัน SQL ทุกคำสั่งในโปรเจคกับ Postgres จริง (in-memory) — `npm run test:sql`
// จับ syntax ผิด / คอลัมน์ไม่มี / constraint ไม่ทำงาน ก่อนที่ผู้ใช้จะเจอ
import assert from 'node:assert';
import { PGlite } from '@electric-sql/pglite';
import { SCHEMA } from './lib/schema.js';

const db = await new PGlite();
const q = (sql, params) => db.query(sql, params);

// ── 1. schema สร้างได้จริง
await db.exec(SCHEMA);
const { rows: [t] } = await q(
  `select count(*)::int as n from information_schema.tables
    where table_schema='public'
      and table_name in ('messages','state','watched','reports','expenses','orders','alerts','people','payments','secrets')`
);
assert.equal(t.n, 10, 'ต้องได้ครบ 10 ตาราง');

// รันซ้ำต้องไม่พัง (ผู้ใช้กด setup สองรอบได้)
await db.exec(SCHEMA);

// ── 2. ingest — กันข้อความซ้ำจาก LINE retry
const ins = (id, text, source = 'Cgroup1') =>
  q(
    `insert into messages (line_message_id, source_type, source_id, user_id, kind, text, ts)
     values ($1,'group',$2,'Uuser1','text',$3, now()) on conflict (line_message_id) do nothing returning id`,
    [id, source, text]
  );
assert.equal((await ins('m1', 'สวัสดี')).rows.length, 1, 'ข้อความใหม่ต้องเก็บได้');
assert.equal((await ins('m1', 'สวัสดี')).rows.length, 0, 'ข้อความซ้ำต้องไม่เก็บอีก');

// ── 3. state — upsert ความจำ
const save = (id, data) =>
  q(
    `insert into state (source_id, data, updated_at) values ($1,$2,now())
     on conflict (source_id) do update set data = $2, updated_at = now()`,
    [id, JSON.stringify(data)]
  );
await save('Uuser1', { chat: [], notes: [{ text: 'wifi 1234' }], todos: [] });
await save('Uuser1', { chat: [], notes: [{ text: 'wifi 5678' }], todos: [] });
const { rows: [s] } = await q('select data from state where source_id = $1', ['Uuser1']);
assert.equal(s.data.notes[0].text, 'wifi 5678', 'เขียนทับความจำได้');

// ── 4. watched — ค่า default ต้องมาครบ และ report_to ว่างได้
await q(`insert into watched (source_id, report_to) values ('Cgroup1', null)`);
const { rows: [w] } = await q('select * from watched where source_id = $1', ['Cgroup1']);
assert.deepEqual(w.report_hours, [8, 18]);
assert.ok(w.alert_words.includes('ยกเลิก'));
assert.equal(w.sla_minutes, 15);
assert.equal(w.active, true);
await q(`update watched set report_to = 'Uowner' where source_id = 'Cgroup1' and report_to is null`);

// ── 5. expenses — สลิปซ้ำต้องไม่เข้าสองรอบ แต่สลิปไม่มีเลขอ้างอิงเข้าได้เรื่อย ๆ
const slip = (ref, amount) =>
  q(
    `insert into expenses (user_id, amount, category, bank, ref, paid_at, confidence)
     values ('Uuser1',$1,'อาหาร','SCB',$2, now(), 0.9)
     on conflict do nothing returning id`,
    [amount, ref]
  );
assert.equal((await slip('REF001', 120)).rows.length, 1);
assert.equal((await slip('REF001', 120)).rows.length, 0, 'สลิปเลขอ้างอิงเดิม+ยอดเดิมต้องไม่ซ้ำ');
assert.equal((await slip('REF002', 120)).rows.length, 1, 'คนละใบต้องเข้าได้');
assert.equal((await slip(null, 50)).rows.length, 1);
assert.equal((await slip(null, 50)).rows.length, 1, 'สลิปไม่มีเลขอ้างอิงห้ามถูกบล็อก');

// ── 6. สรุปรายจ่าย (ตรงกับ expense_summary ใน brain.js)
const days = 30;
const { rows: sum } = await q(
  `select coalesce(category,'อื่น ๆ') as category, sum(amount) as total, count(*) as n
     from expenses where user_id = $1 and paid_at > now() - ($2 || ' days')::interval
    group by 1 order by total desc`,
  ['Uuser1', days]
);
assert.equal(Number(sum[0].total), 340, 'ยอดรวมต้องถูก (120+120+50+50)');

// ── 7. alerts — เตือนซ้ำเรื่องเดิมไม่ได้ แต่คนละชนิดได้
const alert = (kind, ref) =>
  q(`insert into alerts (source_id, kind, ref) values ('Cgroup1',$1,$2) on conflict do nothing returning id`, [kind, ref]);
assert.equal((await alert('keyword', 'm1')).rows.length, 1);
assert.equal((await alert('keyword', 'm1')).rows.length, 0, 'เตือนซ้ำข้อความเดิมไม่ได้');
assert.equal((await alert('sla', 'm1')).rows.length, 1, 'คนละชนิดต้องเตือนได้');

// ── 8. orders — ข้อความเดียวสั่งซ้ำไม่ได้
const { rows: [msg] } = await q(`select id from messages where line_message_id = 'm1'`);
const order = () =>
  q(
    `insert into orders (source_id, customer, items, amount, ordered_at, source_message_id)
     values ('Cgroup1','คุณเอ',$1,250, now(),$2) on conflict (source_message_id) do nothing returning id`,
    [JSON.stringify(['กาแฟ 2']), msg.id]
  );
assert.equal((await order()).rows.length, 1);
assert.equal((await order()).rows.length, 0, 'ข้อความเดิมต้องไม่กลายเป็นออเดอร์ซ้ำ');

// ── 9. คิวรีของ worker — หากลุ่มที่ถึงรอบรายงาน
await q(
  `select * from watched
    where active and report_to is not null and $1 = any(report_hours)
      and (last_report_at is null or last_report_at < now() - interval '2 hours')`,
  [8]
);
// ข้อความที่ยังไม่ได้สรุป
const { rows: pending } = await q(
  `select id, text, ts from messages
    where source_id = $1 and processed_at is null and text is not null order by ts limit $2`,
  ['Cgroup1', 500]
);
assert.equal(pending.length, 1);
// mark ว่าสรุปแล้ว
await q(
  `update messages set processed_at = now() where source_id = $1 and processed_at is null and ts <= $2`,
  ['Cgroup1', pending[0].ts]
);
assert.equal(
  (await q(`select count(*)::int as n from messages where source_id='Cgroup1' and processed_at is null`)).rows[0].n,
  0
);

// ── 10. SLA watcher — ข้อความล่าสุดต่อกลุ่ม
await q(
  `insert into reports (source_id, period_start, period_end, summary)
   values ('Cgroup1', now() - interval '1 hour', now(), 'สรุปทดสอบ')`
);
const { rows: latest } = await q(
  `select distinct on (w.source_id)
          w.source_id, w.title, w.report_to, w.sla_minutes, m.line_message_id, m.text, m.ts
     from watched w join messages m on m.source_id = w.source_id
    where w.active and w.report_to is not null and w.sla_minutes > 0 and m.text is not null
    order by w.source_id, m.ts desc`
);
assert.equal(latest.length, 1);
assert.equal(latest[0].line_message_id, 'm1');

// ── 11. คิวรีของหน้า dashboard
await q('select source_id, data from state order by updated_at desc');
await q('select w.*, (select count(*) from messages m where m.source_id = w.source_id) as msgs from watched w order by w.active desc');
const { rows: rep } = await q(
  `select r.*, w.title,
          to_char(r.created_at at time zone 'Asia/Bangkok', 'YYYY-MM-DD') as day,
          to_char(r.created_at at time zone 'Asia/Bangkok', 'HH24:MI') as at,
          (select count(*) from messages m
            where m.source_id = r.source_id and m.ts between r.period_start and r.period_end) as msgs
     from reports r left join watched w using (source_id)
    order by r.created_at desc limit 60`
);
assert.match(rep[0].day, /^\d{4}-\d{2}-\d{2}$/, 'จัดกลุ่มรายวันต้องได้วันที่แบบไทย');
assert.match(rep[0].at, /^\d{2}:\d{2}$/);
await q(`select coalesce(category,'อื่น ๆ') as category, sum(amount) as total, count(*) as n
           from expenses where paid_at > date_trunc('month', now()) group by 1 order by total desc`);
await q('select * from orders order by ordered_at desc limit 20');

// ── 12. คิวรีของหน้าตรวจสุขภาพ
const { rows: [health] } = await q(
  `select (select count(*) from messages) as msgs, (select count(*) from watched where active) as groups`
);
assert.equal(Number(health.groups), 1);

// ── 13. people — ถามชื่อจาก LINE ครั้งเดียวแล้วจำ (ได้ null ก็ต้องนับว่าถามแล้ว)
const remember = (id, name) =>
  q(
    `insert into people (user_id, name) values ($1,$2)
     on conflict (user_id) do update set name = coalesce(excluded.name, people.name), updated_at = now()`,
    [id, name]
  );
await remember('Uuser1', 'คุณเอ');
await remember('Uleft', null); // คนที่ออกจากกลุ่มไปแล้ว — ไม่ได้ชื่อ
const { rows: people } = await q('select user_id, name from people where user_id = any($1)', [['Uuser1', 'Uleft', 'Unew']]);
assert.equal(people.length, 2, 'คนที่ถามแล้วต้องอยู่ในตาราง ถึงจะไม่ได้ชื่อก็ตาม');
await remember('Uuser1', null);
assert.equal((await q(`select name from people where user_id='Uuser1'`)).rows[0].name, 'คุณเอ', 'ชื่อที่เคยได้ต้องไม่ถูกล้างทิ้ง');

// ── 14. เตือนสุขภาพระบบ — เรื่องเดิมวันเดียวกันต้องเตือนครั้งเดียว
const sick = (ref, detail) =>
  q(
    `insert into alerts (source_id, kind, ref, detail) values ('system','health',$1,$2)
     on conflict do nothing returning id`,
    [ref, detail]
  );
assert.equal((await sick('2026-08-26:token', 'token เหลือ 3 วัน')).rows.length, 1);
assert.equal((await sick('2026-08-26:token', 'token เหลือ 3 วัน')).rows.length, 0, 'เรื่องเดิมวันเดิมต้องไม่เตือนซ้ำ');
assert.equal((await sick('2026-08-27:token', 'token เหลือ 2 วัน')).rows.length, 1, 'วันใหม่ต้องเตือนได้อีก');

// ── 15. คิวรีหางานถึงกำหนด (checkDue)
await save('Uuser2', { chat: [], notes: [], todos: [{ id: 1, text: 'ส่งงาน', due: '2026-08-01 10:00', done: false }] });
const { rows: withTodos } = await q(`select source_id, data from state where jsonb_array_length(data->'todos') > 0`);
assert.equal(withTodos.length, 1, 'ต้องเจอเฉพาะคนที่มีงานค้าง');
assert.equal(withTodos[0].data.todos[0].text, 'ส่งงาน');

// ── 16. คิวรีการเตือนบนกระดาน — ต้องอ่าน detail ของการเตือนที่ไม่มีข้อความ LINE ต้นทางได้
const { rows: shown } = await q(
  `select a.kind, a.source_id, w.title, m.text, a.detail
     from alerts a left join watched w using (source_id)
     left join messages m on m.line_message_id = a.ref
    order by a.created_at desc limit 20`
);
assert.ok(shown.some((a) => a.kind === 'health' && a.detail && !a.text), 'การเตือนระบบต้องมี detail ให้แสดง');

// ── 17. ค้นข้อความย้อนหลัง (search_history) — คิวรีเดียวรับได้ทั้งมีคำค้น/ไม่มี/จำกัดกลุ่ม
await q(`update watched set title = 'ทีมขาย' where source_id = 'Cgroup1'`);
const search = (days, keyword, scope, group) =>
  q(
    `select m.text, m.ts, w.title, p.name as who
       from messages m
       left join watched w on w.source_id = m.source_id
       left join people p on p.user_id = m.user_id
      where m.text is not null
        and m.ts > now() - ($1 || ' days')::interval
        and ($2 = '' or m.text ilike '%' || $2 || '%')
        and ($3::text is null or m.source_id = $3)
        and ($4 = '' or coalesce(w.title, '') ilike '%' || $4 || '%')
      order by m.ts desc limit 60`,
    [days, keyword, scope, group]
  );
const all = await search(30, '', null, '');
assert.equal(all.rows.length, 1, 'ไม่ใส่เงื่อนไข = เจอทุกข้อความ');
assert.equal(all.rows[0].who, 'คุณเอ', 'ต้องบอกได้ว่าใครพูด');
assert.equal(all.rows[0].title, 'ทีมขาย');
assert.equal((await search(30, 'สวัสดี', null, '')).rows.length, 1, 'ค้นด้วยคำไทยต้องเจอ');
assert.equal((await search(30, 'ไม่มีคำนี้', null, '')).rows.length, 0);
assert.equal((await search(30, '', 'Cother', '')).rows.length, 0, 'สั่งในกลุ่ม = ต้องไม่เห็นข้อความของกลุ่มอื่น');
assert.equal((await search(30, '', null, 'ทีมขาย')).rows.length, 1, 'ค้นด้วยชื่อกลุ่มต้องเจอ');
assert.equal((await search(0, '', null, '')).rows.length, 0, 'ย้อนหลัง 0 วัน = ไม่เห็นอะไร');

// ── 18. เงินเข้าจากสลิปในกลุ่ม — จับคู่ออเดอร์ยอดเท่ากันที่ยังไม่จ่าย
const { rows: [ord] } = await q(`select id, amount from orders where source_id = 'Cgroup1' limit 1`);
const { rows: [match] } = await q(
  `select id from orders where source_id = $1 and paid_at is null and amount = $2 order by ordered_at desc limit 1`,
  ['Cgroup1', ord.amount]
);
assert.equal(match.id, ord.id, 'ต้องหาออเดอร์ยอดตรงกันที่ยังไม่จ่ายเจอ');

const pay = (ref, amount, orderId, msgId) =>
  q(
    `insert into payments (source_id, amount, bank, ref, paid_at, matched_order_id, source_message_id)
     values ('Cgroup1',$1,'SCB',$2, now(),$3,$4) on conflict do nothing returning id`,
    [amount, ref, orderId, msgId]
  );
assert.equal((await pay('P001', 250, match.id, msg.id)).rows.length, 1);
assert.equal((await pay('P001', 250, match.id, msg.id)).rows.length, 0, 'สลิปใบเดิม (ข้อความเดิม) ต้องไม่เข้าซ้ำ');
await q('update orders set paid_at = now(), paid_ref = $2 where id = $1', [match.id, 'P001']);
assert.equal(
  (await q(`select count(*)::int as n from orders where source_id='Cgroup1' and paid_at is null`)).rows[0].n,
  0,
  'ออเดอร์ต้องถูกมาร์คว่าจ่ายแล้ว'
);
const { rows: [money] } = await q(
  `select count(*)::int as n, coalesce(sum(amount),0) as total,
          count(*) filter (where matched_order_id is not null)::int as matched
     from payments where source_id = 'Cgroup1' and created_at > now() - interval '1 hour'`
);
assert.equal(money.n, 1);
assert.equal(money.matched, 1, 'ต้องนับได้ว่าจับคู่ออเดอร์ได้กี่ใบ');

// ── 19. token ที่ระบบต่ออายุเอง — เขียนทับของเดิมได้ ไม่สร้างแถวซ้ำ
const keep = (token, days) =>
  q(
    `insert into secrets (name, value, expires_at, updated_at) values ('line_token',$1,$2,now())
     on conflict (name) do update set value = $1, expires_at = $2, updated_at = now()`,
    [token, new Date(Date.now() + days * 86400000)]
  );
await keep('token-เก่า', 1);
await keep('token-ใหม่', 30);
const { rows: sec } = await q(`select value, expires_at from secrets where name = 'line_token'`);
assert.equal(sec.length, 1, 'ต้องมีแถวเดียว ไม่สะสม');
assert.equal(sec[0].value, 'token-ใหม่', 'ต้องได้ตัวล่าสุด');
assert.ok(new Date(sec[0].expires_at) > new Date(Date.now() + 2 * 86400000), 'ตัวใหม่ต้องเหลืออายุเกิน 2 วัน');

// ── 20. ยอดขาย — ส่งยอดวัน/สินค้า/ช่องทางเดิมซ้ำ = แก้ยอด ไม่บวกซ้ำ
const sell = (date, product, amount, channel = '') =>
  q(
    `insert into sales (user_id, sale_date, product, channel, amount, units) values ('Uowner',$1,$2,$3,$4,null)
     on conflict (user_id, sale_date, product, channel)
     do update set amount = excluded.amount, units = excluded.units, created_at = now()`,
    [date, product, channel, amount]
  );
await sell('2026-09-21', 'สินค้า A', 1000);
await sell('2026-09-22', 'สินค้า A', 1500);
await sell('2026-09-22', 'สินค้า A', 2000); // แก้ยอด
await sell('2026-09-22', 'สินค้า A', 500, 'TikTok'); // ช่องทางอื่น = แถวใหม่
const { rows: [day] } = await q(
  `select coalesce(sum(amount) filter (where sale_date = $2), 0) as today,
          coalesce(sum(amount) filter (where sale_date = $2::date - 1), 0) as prev
     from sales where user_id = $1 and sale_date between $2::date - 1 and $2::date`,
  ['Uowner', '2026-09-22']
);
assert.equal(Number(day.today), 2500, 'วันเดียวกันรวมทุกช่องทาง และใช้ยอดที่แก้แล้ว');
assert.equal(Number(day.prev), 1000, 'ต้องได้ยอดวันก่อนไว้เทียบ');
const { rows: salesRows } = await q(
  `select sale_date::text as d, product, sum(amount)::float8 as amount
     from sales where user_id = $1 and sale_date between $2 and $3
    group by 1, 2 order by 1, 2`,
  ['Uowner', '2026-09-15', '2026-09-22']
);
assert.deepEqual(salesRows.map((r) => [r.d, r.amount]), [['2026-09-21', 1000], ['2026-09-22', 2500]], 'สรุปรายวันต้องได้ วันที่เป็นข้อความ ยอดเป็นตัวเลข');

console.log('✅ SQL ผ่านหมด 20 หมวด (รันกับ Postgres จริง)');
