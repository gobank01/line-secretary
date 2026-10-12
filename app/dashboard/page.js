import { q } from '@/lib/db';

export const dynamic = 'force-dynamic';

const baht = (n) => Number(n || 0).toLocaleString('th-TH', { maximumFractionDigits: 0 });

export default async function Dashboard({ searchParams }) {
  const { key, demo } = await searchParams;
  // ponytail: key เส้นเดียวพอสำหรับข้อมูลงาน — ถ้าจะเก็บข้อมูลสุขภาพ/การเงิน ต้องเปลี่ยนเป็น login จริง (ดู DESIGN.md)
  // ตั้ง DASHBOARD_PUBLIC=1 = เปิดให้ใครก็อ่านได้ (ข้อมูลลูกค้าโผล่หมด — ตั้งใจแล้วค่อยเปิด)
  const locked = process.env.DASHBOARD_PUBLIC !== '1' && key !== process.env.DASHBOARD_KEY;
  if (locked) {
    return (
      <main className="gate">
        <style>{CSS}</style>
        <div className="gate-card">
          <img className="gate-logo" src="/avatar.png" alt="" width="56" height="56" />
          <h1>ต้องมีกุญแจก่อนครับ</h1>
          <p>เติม <code>?key=...</code> ท้าย URL ให้ตรงกับ <code>DASHBOARD_KEY</code></p>
        </div>
      </main>
    );
  }

  // ชื่อ → คิวรี · เลี่ยงการรับผลลัพธ์เป็นลำดับ (สลับตำแหน่งทีเดียวหน้าพังทั้งหน้า โดยไม่มีอะไรเตือน)
  const data = Object.fromEntries(
    await Promise.all(Object.entries(QUERIES).map(async ([key, sql]) => [key, (await q(sql)).rows]))
  );

  // &demo=1 = ดูหน้าตาเต็ม ๆ ด้วยข้อมูลสมมุติ (ไม่แตะฐานข้อมูลจริง)
  const { states, groups, reports, expenses, expDays, orders, paid, alerts, pulse } = demo ? DEMO : data;

  const spent = expenses.reduce((s, e) => s + Number(e.total), 0);
  const maxCat = Math.max(1, ...expenses.map((e) => Number(e.total)));
  const maxDay = Math.max(1, ...expDays.map((e) => Number(e.total)));
  const todos = states.flatMap(({ source_id, data }) =>
    (data.todos || []).filter((t) => !t.done).map((t) => ({ ...t, source_id }))
  );
  const notes = states.flatMap(({ source_id, data }) =>
    (data.notes || []).map((n) => ({ ...n, source_id }))
  );
  const activeGroups = groups.filter((g) => g.active).length;
  const p = pulse[0] || {};
  const now = new Date().toLocaleString('th-TH', {
    timeZone: 'Asia/Bangkok', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });

  return (
    <main className="wrap">
      <style>{CSS}</style>

      {demo && <div className="demo-flag">👀 โหมดตัวอย่าง — ข้อมูลสมมุติไว้ดูหน้าตา · ตัดคำว่า <code>&demo=1</code> ออกเพื่อดูข้อมูลจริง</div>}
      <header className="hero">
        <div className="hero-glow" />
        <div className="hero-row">
          <img className="avatar" src="/avatar.png" alt="" width="52" height="52" />
          <div>
            <h1>{process.env.BOT_NAME || 'เลขาส่วนตัว'}</h1>
            <p className="hero-sub">สรุปงานประจำวัน · อัปเดต {now} น.</p>
          </div>
        </div>
        <div className="chips">
          <span className="chip">👀 เฝ้า {activeGroups} กลุ่ม</span>
          <span className="chip">💬 {p.msgs_today || 0} ข้อความ/24ชม.</span>
          <span className="chip">📋 รายงาน {p.reports_today || 0} รอบวันนี้</span>
        </div>
      </header>

      <section className="stats">
        <Stat label="ที่ต้องรู้ทันที" value={p.alerts_today || 0} unit="เรื่องวันนี้" tone={Number(p.alerts_today) ? 'hot' : ''} />
        <Stat label="งานค้าง" value={todos.length} unit="รายการ" />
        <Stat label="รายจ่ายเดือนนี้" value={baht(spent)} unit="บาท" />
        <Stat label="ของที่จดไว้" value={notes.length} unit="โน้ต" />
      </section>

      <Section title="ที่ต้องรู้ทันที" icon="🚨" count={alerts.length} empty={!alerts.length} emptyText="เงียบดี ไม่มีเรื่องด่วน">
        <div className="list">
          {alerts.map((a, i) => (
            <div key={i} className={`alert ${ALERT[a.kind]?.cls || 'kw'} ${a.fresh ? 'fresh' : ''}`}>
              <div className="alert-head">
                <b>{ALERT[a.kind]?.label || '⚠️ คำต้องห้าม'}</b>
                <span className="dim">
                  {a.at} น. · {a.kind === 'health' ? 'ระบบ' : a.title || a.source_id.slice(0, 12) + '…'}
                </span>
              </div>
              {a.detail && <p className="quote">{a.detail}</p>}
              {a.text && <p className="quote">“{a.text.slice(0, 220)}”</p>}
            </div>
          ))}
        </div>
      </Section>

      <div className="cols">
        <Section title="งานค้าง" icon="☑️" count={todos.length} empty={!todos.length} emptyText='สั่งได้เลย เช่น "เตือนส่งงานพรุ่งนี้ 10 โมง"'>
          <div className="list">
            {todos.map((t) => (
              <div key={`${t.source_id}-${t.id}`} className="todo">
                <span className="tick">☐</span>
                <div>
                  <p className="todo-text">{t.text}</p>
                  {t.due && <span className="due">⏱ {t.due}</span>}
                </div>
                <span className="idtag">#{t.id}</span>
              </div>
            ))}
          </div>
        </Section>

        <Section title="ของที่จดไว้" icon="🧠" count={notes.length} empty={!notes.length} emptyText='ทักว่า "จดไว้ ..." ได้เลย'>
          <div className="list">
            {notes.map((n, i) => (
              <div key={i} className="note">
                <p>{n.text}</p>
                <span className="dim">
                  {n.id ? `#${n.id}` : ''}
                  {n.at && ` · ${new Date(n.at).toLocaleDateString('th-TH', { day: 'numeric', month: 'short' })}`}
                </span>
              </div>
            ))}
          </div>
        </Section>
      </div>

      <Section title="กลุ่มที่เฝ้าอยู่" icon="👀" count={groups.length} empty={!groups.length} emptyText={`เชิญ${process.env.BOT_NAME || 'เลขา'}เข้ากลุ่มได้เลย`}>
        <div className="table">
          <div className="tr th">
            <span>กลุ่ม</span><span>ข้อความ</span><span>24 ชม.</span><span>รายงาน</span><span>ล่าสุด</span>
          </div>
          {groups.map((g) => (
            <div key={g.source_id} className="tr">
              <span className="gname">
                <i className={g.active ? 'dot on' : 'dot'} />
                {g.title || g.source_id.slice(0, 14) + '…'}
              </span>
              <span>{g.msgs}</span>
              <span className={Number(g.msgs_today) ? 'strong' : 'dim'}>{g.msgs_today}</span>
              <span className="dim">{(g.report_hours || []).join(', ')} น.</span>
              <span className="dim">{g.last_report || '—'}</span>
            </div>
          ))}
        </div>
      </Section>

      <div className="cols">
        <Section title="รายจ่ายเดือนนี้" icon="🧾" badge={`${baht(spent)} บาท`} empty={!expenses.length} emptyText="ส่งสลิปเข้า LINE ได้เลย">
          <div className="list">
            {expenses.map((e) => (
              <div key={e.category} className="bar-row">
                <div className="bar-top">
                  <span>{e.category} <span className="dim">({e.n})</span></span>
                  <b>{baht(e.total)}</b>
                </div>
                <div className="bar"><i style={{ width: `${(Number(e.total) / maxCat) * 100}%` }} /></div>
              </div>
            ))}
            {expDays.length > 1 && (
              <div className="spark">
                <p className="dim">รายวัน</p>
                <div className="spark-bars">
                  {expDays.map((d) => (
                    <div key={d.d} className="spark-col" title={`${d.d} — ${baht(d.total)} บาท`}>
                      <i style={{ height: `${Math.max(6, (Number(d.total) / maxDay) * 100)}%` }} />
                      <span>{d.d}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </Section>

        <Section title="ออเดอร์ล่าสุด" icon="📦" count={orders.length} empty={!orders.length} emptyText="เปิด track_orders ในกลุ่มที่รับออเดอร์">
          {Number(paid[0]?.n) > 0 && (
            <p className="dim" style={{ marginBottom: 10 }}>
              💰 เงินเข้าเดือนนี้ {paid[0].n} ใบ · รวม {baht(paid[0].total)} บาท
            </p>
          )}
          <div className="list">
            {orders.map((o) => (
              <div key={o.id} className="order">
                <div>
                  <b>{o.customer || 'ไม่ระบุชื่อ'}</b>
                  <p className="dim">{(o.items || []).join(', ') || '—'}</p>
                </div>
                <div className="order-right">
                  {o.amount && <b className="amount">{baht(o.amount)} ฿</b>}
                  <span className="dim">{o.paid ? '✅ จ่ายแล้ว · ' : ''}{o.at}</span>
                </div>
              </div>
            ))}
          </div>
        </Section>
      </div>

      <Section title="สรุปบทสนทนา" icon="📋" count={reports.length} empty={!reports.length} emptyText='รอรอบ 8 โมง / 6 โมงเย็น หรือพิมพ์ "เลขา สรุปให้หน่อย" ในกลุ่ม'>
        {Object.entries(Object.groupBy(reports, (r) => r.day)).map(([day, items]) => (
          <div key={day} className="day-block">
            <div className="day-head">
              <span className="day-pill">
                {new Date(day).toLocaleDateString('th-TH', { weekday: 'short', day: 'numeric', month: 'short' })}
              </span>
              <span className="dim">{items.reduce((s, r) => s + Number(r.msgs), 0)} ข้อความ · {items.length} รายงาน</span>
            </div>
            {items.map((r) => (
              <article key={r.id} className="report">
                <div className="report-head">
                  <b>{r.title || r.source_id.slice(0, 14) + '…'}</b>
                  <span className="dim">{r.at} น. · {r.msgs} ข้อความ</span>
                </div>
                <p className="report-body">{r.summary}</p>
              </article>
            ))}
          </div>
        ))}
      </Section>

      <footer className="foot">ข้อมูลสด ๆ จาก Neon ทุกครั้งที่เปิดหน้านี้</footer>
    </main>
  );
}

function Stat({ label, value, unit, tone = '' }) {
  return (
    <div className={`stat ${tone}`}>
      <p className="stat-label">{label}</p>
      <p className="stat-value">{value} <span>{unit}</span></p>
    </div>
  );
}

function Section({ title, icon, count, badge, empty, emptyText, children }) {
  return (
    <section className="card">
      <div className="card-head">
        <h2><span className="ico">{icon}</span>{title}</h2>
        {badge ? <span className="badge">{badge}</span> : count != null && <span className="badge">{count}</span>}
      </div>
      {empty ? <p className="empty">{emptyText}</p> : children}
    </section>
  );
}

const CSS = `
:root{
  --p700:#5B21B6; --p600:#6D28D9; --p500:#7C3AED; --p400:#A78BFA;
  --p100:#EDE9FE; --p50:#F6F3FF; --line:#EAE4FA;
  --ink:#231238; --muted:#7C7192; --hot:#E11D48; --warn:#D97706;
}
*{box-sizing:border-box}
body{margin:0;background:var(--p50);color:var(--ink);
  font-family:"Noto Sans Thai","IBM Plex Sans Thai",system-ui,-apple-system,"Segoe UI",sans-serif;
  line-height:1.65;-webkit-font-smoothing:antialiased}
.wrap{max-width:1080px;margin:0 auto;padding:20px 16px 64px}
h1,h2{margin:0}
p{margin:0}
.dim{color:var(--muted);font-size:13px}
.strong{font-weight:700;color:var(--p600)}

/* hero */
.hero{position:relative;overflow:hidden;border-radius:24px;padding:26px 24px;
  background:linear-gradient(135deg,var(--p700) 0%,var(--p500) 55%,#9F67F0 100%);
  color:#fff;box-shadow:0 18px 40px -18px rgba(91,33,182,.55)}
.hero::before{content:'';position:absolute;inset:0;background:url('/hero.jpg') center/cover no-repeat;
  opacity:.85;mix-blend-mode:screen;pointer-events:none}
.hero-glow{position:absolute;inset:auto -60px -120px auto;width:280px;height:280px;border-radius:50%;
  background:rgba(255,255,255,.16);filter:blur(10px)}
.hero-row{display:flex;align-items:center;gap:14px;position:relative}
.hero h1{font-size:26px;letter-spacing:-.02em}
.hero-sub{color:rgba(255,255,255,.82);font-size:14px}
.avatar{width:52px;height:52px;border-radius:16px;object-fit:cover;flex:none;
  background:rgba(255,255,255,.9);border:1px solid rgba(255,255,255,.5);
  box-shadow:0 6px 16px -8px rgba(0,0,0,.5)}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px;position:relative}
.chip{background:rgba(255,255,255,.16);border:1px solid rgba(255,255,255,.25);
  padding:5px 12px;border-radius:999px;font-size:13px}

/* stats */
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-top:16px}
.stat{background:#fff;border:1px solid var(--line);border-radius:18px;padding:16px 18px;
  box-shadow:0 6px 18px -14px rgba(91,33,182,.5)}
.stat-label{font-size:13px;color:var(--muted)}
.stat-value{font-size:26px;font-weight:800;color:var(--p600);letter-spacing:-.02em;margin-top:2px}
.stat-value span{font-size:13px;font-weight:500;color:var(--muted)}
.stat.hot{background:linear-gradient(180deg,#FFF1F4,#fff);border-color:#FBD5DE}
.stat.hot .stat-value{color:var(--hot)}

/* cards */
.card{background:#fff;border:1px solid var(--line);border-radius:20px;padding:18px 20px;margin-top:16px;
  box-shadow:0 8px 24px -20px rgba(91,33,182,.6)}
.card-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px}
.card h2{font-size:16px;display:flex;align-items:center;gap:8px}
.ico{display:inline-grid;place-items:center;width:28px;height:28px;border-radius:9px;background:var(--p100)}
.badge{background:var(--p100);color:var(--p700);font-size:12px;font-weight:700;
  padding:3px 10px;border-radius:999px;white-space:nowrap}
.empty{color:var(--muted);font-size:14px;padding:6px 0 2px}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.cols>.card{margin-top:16px}
.list{display:flex;flex-direction:column;gap:10px}

/* alerts */
.alert{border-left:3px solid var(--warn);background:#FFFBF3;border-radius:0 12px 12px 0;padding:10px 14px}
.alert.kw{border-color:var(--hot);background:#FFF5F7}
.alert.sys{border-color:var(--p500);background:var(--p50)}
.alert.fresh{box-shadow:0 0 0 3px rgba(225,29,72,.07)}
.alert-head{display:flex;flex-wrap:wrap;gap:8px;align-items:baseline;justify-content:space-between}
.alert-head b{font-size:14px}
.quote{margin-top:4px;font-size:14px;color:#4A3A63}

/* todo / note */
.todo{display:flex;gap:10px;align-items:flex-start;background:var(--p50);border:1px solid var(--line);
  border-radius:12px;padding:10px 12px}
.tick{color:var(--p500);font-size:16px;line-height:1.4}
.todo-text{font-size:14px}
.due{font-size:12px;color:var(--p600);background:var(--p100);padding:1px 8px;border-radius:999px}
.idtag{margin-left:auto;font-size:12px;color:var(--muted)}
.note{background:var(--p50);border:1px solid var(--line);border-radius:12px;padding:10px 12px;font-size:14px}

/* table */
.table{display:flex;flex-direction:column}
.tr{display:grid;grid-template-columns:2.2fr .8fr .8fr 1.2fr 1fr;gap:8px;align-items:center;
  padding:9px 4px;border-bottom:1px solid var(--line);font-size:14px}
.tr.th{font-size:12px;color:var(--muted);border-bottom:2px solid var(--p100);font-weight:600}
.tr:last-child{border-bottom:none}
.gname{display:flex;align-items:center;gap:8px;font-weight:600;overflow:hidden;text-overflow:ellipsis}
.dot{width:8px;height:8px;border-radius:50%;background:#D7CEEA;flex:none}
.dot.on{background:#22C55E;box-shadow:0 0 0 3px rgba(34,197,94,.16)}

/* bars */
.bar-row{display:flex;flex-direction:column;gap:5px}
.bar-top{display:flex;justify-content:space-between;font-size:14px}
.bar{height:9px;border-radius:999px;background:var(--p100);overflow:hidden}
.bar i{display:block;height:100%;border-radius:999px;
  background:linear-gradient(90deg,var(--p600),var(--p400))}
.spark{margin-top:8px;border-top:1px dashed var(--line);padding-top:10px}
.spark-bars{display:flex;align-items:flex-end;gap:4px;height:76px;margin-top:6px}
.spark-col{flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;height:100%;gap:4px}
.spark-col i{display:block;width:100%;border-radius:5px 5px 2px 2px;
  background:linear-gradient(180deg,var(--p400),var(--p600))}
.spark-col span{font-size:10px;color:var(--muted)}

/* orders */
.order{display:flex;justify-content:space-between;gap:12px;background:var(--p50);
  border:1px solid var(--line);border-radius:12px;padding:10px 12px;font-size:14px}
.order-right{text-align:right;display:flex;flex-direction:column}
.amount{color:var(--p600)}

/* reports */
.day-block{margin-top:14px}
.day-head{display:flex;align-items:center;gap:10px;margin-bottom:8px}
.day-pill{background:var(--p600);color:#fff;font-size:12px;font-weight:700;padding:3px 12px;border-radius:999px}
.report{border:1px solid var(--line);border-radius:14px;padding:12px 14px;margin-bottom:10px;background:#fff}
.report-head{display:flex;flex-wrap:wrap;gap:8px;justify-content:space-between;align-items:baseline;
  border-bottom:1px dashed var(--line);padding-bottom:6px;margin-bottom:8px}
.report-body{white-space:pre-wrap;font-size:14px;color:#3A2B52}

.demo-flag{background:#FFF7E6;border:1px dashed #E9C46A;color:#7A5A12;font-size:13px;
  padding:8px 14px;border-radius:12px;margin-bottom:12px}
.foot{text-align:center;color:var(--muted);font-size:12px;margin-top:28px}

/* gate */
.gate{min-height:100vh;display:grid;place-items:center;padding:24px;
  background:linear-gradient(135deg,var(--p700),var(--p500))}
.gate-card{background:#fff;border-radius:22px;padding:32px;text-align:center;max-width:380px;
  box-shadow:0 24px 60px -30px rgba(0,0,0,.5)}
.gate-logo{width:56px;height:56px;border-radius:18px;margin:0 auto 14px;object-fit:cover;
  background:var(--p100);display:block}
.gate-card h1{font-size:19px;margin-bottom:6px}
.gate-card p{font-size:14px;color:var(--muted)}
code{background:var(--p100);color:var(--p700);padding:1px 6px;border-radius:6px;font-size:13px}

@media (max-width:760px){
  .cols{grid-template-columns:1fr}
  .tr{grid-template-columns:1.6fr .7fr .7fr;font-size:13px}
  .tr>span:nth-child(4),.tr>span:nth-child(5){display:none}
  .hero h1{font-size:22px}
}
`;

// ข้อมูลสมมุติสำหรับดูหน้าตา — เปิดด้วย &demo=1 (ไม่แตะฐานข้อมูลจริง)
const QUERIES = {
  states: 'select source_id, data, updated_at from state order by updated_at desc',

  groups: `select w.*,
             (select count(*) from messages m where m.source_id = w.source_id) as msgs,
             (select count(*) from messages m where m.source_id = w.source_id
                and m.ts > now() - interval '24 hours') as msgs_today,
             to_char(w.last_report_at at time zone 'Asia/Bangkok', 'DD/MM HH24:MI') as last_report
        from watched w order by w.active desc, msgs desc`,

  reports: `select r.*, w.title,
              to_char(r.created_at at time zone 'Asia/Bangkok', 'YYYY-MM-DD') as day,
              to_char(r.created_at at time zone 'Asia/Bangkok', 'HH24:MI') as at,
              (select count(*) from messages m
                where m.source_id = r.source_id and m.ts between r.period_start and r.period_end) as msgs
         from reports r left join watched w using (source_id)
        order by r.created_at desc limit 60`,

  expenses: `select coalesce(category,'อื่น ๆ') as category, sum(amount) as total, count(*) as n
               from expenses where paid_at > date_trunc('month', now()) group by 1 order by total desc`,

  expDays: `select to_char(paid_at at time zone 'Asia/Bangkok', 'DD') as d, sum(amount) as total
              from expenses where paid_at > date_trunc('month', now()) group by 1 order by 1`,

  orders: `select o.*, o.paid_at is not null as paid,
             to_char(o.ordered_at at time zone 'Asia/Bangkok', 'DD/MM HH24:MI') as at
        from orders o order by o.ordered_at desc limit 20`,

  paid: `select coalesce(sum(amount),0) as total, count(*)::int as n
           from payments where created_at > date_trunc('month', now())`,

  alerts: `select a.kind, a.source_id, w.title, m.text, a.detail,
             to_char(a.created_at at time zone 'Asia/Bangkok', 'DD/MM HH24:MI') as at,
             a.created_at > now() - interval '24 hours' as fresh
        from alerts a
        left join watched w using (source_id)
        left join messages m on m.line_message_id = a.ref
       order by a.created_at desc limit 20`,

  pulse: `select (select count(*) from messages where ts > now() - interval '24 hours') as msgs_today,
                 (select count(*) from alerts   where created_at > now() - interval '24 hours') as alerts_today,
                 (select count(*) from reports  where created_at > now() - interval '24 hours') as reports_today`,
};

const ALERT = {
  sla: { cls: 'sla', label: '⏰ ถามค้าง ยังไม่มีใครตอบ' },
  keyword: { cls: 'kw', label: '⚠️ คำต้องห้าม' },
  health: { cls: 'sys', label: '🩺 ระบบมีปัญหา' },
};

const DEMO = {
  states: [
    { source_id: 'Udemo', updated_at: new Date(), data: {
      todos: [
        { id: 1, text: 'ส่งใบเสนอราคาโซลาร์ให้ร้านกาแฟละมุน', due: 'พรุ่งนี้ 10:00' },
        { id: 2, text: 'อัดคลิปบทที่ 4 คอร์ส Claude Code' },
        { id: 3, text: 'โทรหาช่างเรื่องคิวติดตั้งหลังคาโกดัง', due: 'ศุกร์นี้' },
      ],
      notes: [
        { id: 1, at: new Date().toISOString(), text: 'รหัส wifi ออฟฟิศ: bizdrive2569' },
        { id: 2, at: new Date().toISOString(), text: 'ค่าแผงโซลาร์ล็อตใหม่ 4,150 บาท/แผง ส่งฟรีเกิน 20 แผง' },
      ] } },
  ],
  groups: [
    { source_id: 'C1', title: 'ทีมติดตั้งโซลาร์', active: true, msgs: 1284, msgs_today: 96, report_hours: [8, 18], last_report: '26/08 08:02' },
    { source_id: 'C2', title: 'ลูกค้า — โกดังบางนา', active: true, msgs: 431, msgs_today: 12, report_hours: [8, 18], last_report: '26/08 08:02' },
    { source_id: 'C3', title: 'นักเรียนคอร์ส AI รุ่น 7', active: true, msgs: 2650, msgs_today: 214, report_hours: [8, 20], last_report: '25/08 20:01' },
    { source_id: 'C4', title: 'ซัพพลายเออร์แผง', active: false, msgs: 88, msgs_today: 0, report_hours: [8], last_report: '19/08 08:03' },
  ],
  reports: [
    { id: 1, source_id: 'C1', title: 'ทีมติดตั้งโซลาร์', day: '2026-08-26', at: '08:02', msgs: 96,
      summary: '• ช่างเอกแจ้งงานโกดังบางนาเสร็จ 80% เหลือเดินสาย DC ฝั่งตะวันตก คาดจบพรุ่งนี้เย็น\n• ต้องตัดสินใจ: อินเวอร์เตอร์ที่สั่งมาผิดรุ่น (5kW แทน 8kW) ช่างถามว่าจะรอของใหม่ 5 วัน หรือใช้ 5kW ไปก่อน — รอเจ้าของเคาะ\n• ค่าใช้จ่ายหน้างานวันนี้ 3,480 บาท (ค่ารถเครน + น้ำมัน)' },
    { id: 2, source_id: 'C3', title: 'นักเรียนคอร์ส AI รุ่น 7', day: '2026-08-26', at: '08:02', msgs: 214,
      summary: '• 6 คนติดขั้นตอนต่อ MCP กับ Claude Code — อาการเดียวกันหมด (ลืม restart หลังแก้ config)\n• คุณแนนถามเรื่องใบเสร็จหัก ณ ที่จ่าย ยังไม่มีใครตอบ 3 ชั่วโมง\n• เสียงตอบรับบทที่ 3 ดีมาก มี 4 คนขอให้ทำบทเสริมเรื่อง subagent' },
    { id: 3, source_id: 'C2', title: 'ลูกค้า — โกดังบางนา', day: '2026-08-25', at: '18:01', msgs: 34,
      summary: '• ลูกค้าถามความคืบหน้าและขอรูปหน้างานทุกวัน\n• ขอเลื่อนวันตรวจรับจาก 30 ส.ค. เป็น 2 ก.ย.\n• ยังไม่ได้โอนงวด 2 (150,000 บาท) — แจ้งว่าจะโอนต้นสัปดาห์หน้า' },
  ],
  expenses: [
    { category: 'ค่าแรงช่าง', total: 42500, n: 9 },
    { category: 'วัสดุ/อุปกรณ์', total: 31800, n: 14 },
    { category: 'ค่าเดินทาง', total: 8650, n: 22 },
    { category: 'โฆษณา', total: 6000, n: 3 },
    { category: 'อื่น ๆ', total: 2140, n: 7 },
  ],
  expDays: [
    { d: '18', total: 4200 }, { d: '19', total: 11800 }, { d: '20', total: 2600 },
    { d: '21', total: 9400 }, { d: '22', total: 15200 }, { d: '23', total: 3100 },
    { d: '24', total: 7600 }, { d: '25', total: 22800 }, { d: '26', total: 3480 },
  ],
  orders: [
    { id: 1, customer: 'ร้านกาแฟละมุน', items: ['แผง 550W x 12', 'อินเวอร์เตอร์ 5kW'], amount: 168000, at: '26/08 09:14' },
    { id: 2, customer: 'คุณเอ๋ ปทุมธานี', items: ['ชุดออนกริด 3kW'], amount: 89000, at: '25/08 16:40' },
    { id: 3, customer: 'โกดังบางนา (งวด 2)', items: ['ติดตั้ง 20kW'], amount: 150000, at: '24/08 11:02' },
  ],
  paid: [{ n: 3, total: 12800 }],
  alerts: [
    { kind: 'keyword', source_id: 'C2', title: 'ลูกค้า — โกดังบางนา', at: '26/08 13:41', fresh: true,
      text: 'ถ้าเลื่อนอีกรอบผมขอยกเลิกสัญญาแล้วนะครับ รอมาสองอาทิตย์แล้ว' },
    { kind: 'sla', source_id: 'C3', title: 'นักเรียนคอร์ส AI รุ่น 7', at: '26/08 10:15', fresh: true,
      text: 'ขอถามหน่อยค่ะ ใบเสร็จหัก ณ ที่จ่าย 3% ต้องออกในนามบริษัทไหนคะ' },
    { kind: 'keyword', source_id: 'C1', title: 'ทีมติดตั้งโซลาร์', at: '25/08 17:22', fresh: false,
      text: 'ของมาผิดรุ่นครับ ด่วนมาก พรุ่งนี้ทีมเข้าหน้างานแล้ว' },
  ],
  pulse: [{ msgs_today: 322, alerts_today: 2, reports_today: 2 }],
};
