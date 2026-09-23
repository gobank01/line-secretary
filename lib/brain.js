// สมองของเลขา — OpenRouter + tool calling (ไม่ใช้ SDK/framework, fetch อย่างเดียว)
import { q } from './db.js';
import { PERSONA } from './persona.js';
import { agenda, agendaText, hasCalendar } from './calendar.js';
import { events, driveSearch, driveRead, hasGoogle } from './google.js';

const MODEL = process.env.OPENROUTER_MODEL || 'google/gemini-2.5-flash';
const STT_MODEL = process.env.OPENROUTER_STT_MODEL || 'openai/whisper-1';
// อ่านสลิปต้องใช้โมเดลที่ดูรูปได้ — สมองหลักบางตัว (เช่น DeepSeek V4) อ่านได้แค่ข้อความ
const VISION_MODEL = process.env.OPENROUTER_VISION_MODEL || MODEL;
const OR = 'https://openrouter.ai/api/v1';
// จำบทสนทนากี่ข้อความ (นับทั้งของเราและของบอท) — 24 = ประมาณ 12 คู่ถาม-ตอบ
// ยิ่งเยอะยิ่งจำได้ไกล แต่จ่ายค่า token เพิ่มทุกข้อความ
const CHAT_MEMORY = Number(process.env.CHAT_MEMORY) || 24;
const auth = () => ({
  Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
  'Content-Type': 'application/json',
});

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'save_note',
      description: 'บันทึกข้อมูลที่ผู้ใช้บอกให้จำไว้ เช่น รหัสผ่าน เลขบัญชี ของที่ต้องซื้อ',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: 'สิ่งที่ต้องจำ เขียนให้ครบในตัวเอง' } },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'forget_note',
      description: 'ลบสิ่งที่เคยจดไว้ ใช้เมื่อผู้ใช้บอกว่าลืมได้แล้ว/ไม่ใช้แล้ว/จดผิด · อยากแก้ให้ลบอันเก่าแล้วจดใหม่',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'number', description: 'เลขโน้ตที่เห็นในรายการ (รู้เลขให้ใช้อันนี้)' },
          q: { type: 'string', description: 'ข้อความบางส่วนของโน้ตที่จะลบ ใช้เมื่อไม่รู้เลข' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_history',
      description:
        'ค้นข้อความเก่าที่เคยคุยกัน ใช้เมื่อผู้ใช้ถามถึงเรื่องที่คุยไปนานแล้วจนจำไม่ได้ ' +
        'เช่น "เคยคุยเรื่องราคาไว้ว่าไง" "กลุ่มโซลาร์เมื่อวานสรุปว่าอะไร"',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: 'คำที่ต้องมีในข้อความ ไม่รู้ก็เว้นว่าง' },
          group: { type: 'string', description: 'ชื่อกลุ่มที่จะค้น (ไม่ระบุ = ทุกที่)' },
          days: { type: 'number', description: 'ย้อนหลังกี่วัน ไม่บอก = 30' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_todo',
      description: 'เพิ่มงานที่ต้องทำ',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          due: { type: 'string', description: 'กำหนดส่งแบบ YYYY-MM-DD HH:mm (ถ้าผู้ใช้บอก)' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'done_todo',
      description: 'ปิดงานที่ทำเสร็จแล้ว ใช้เลข id ที่เห็นในรายการ',
      parameters: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_expense',
      description: 'บันทึกรายจ่าย ใช้เมื่อผู้ใช้บอกว่าจ่ายอะไรไปเท่าไหร่',
      parameters: {
        type: 'object',
        properties: {
          amount: { type: 'number' },
          category: { type: 'string', description: 'เช่น อาหาร เดินทาง ของใช้ ค่าบริการ' },
          note: { type: 'string' },
        },
        required: ['amount'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'expense_summary',
      description: 'ดูสรุปรายจ่าย ใช้เมื่อผู้ใช้ถามว่าใช้เงินไปเท่าไหร่',
      parameters: {
        type: 'object',
        properties: { days: { type: 'number', description: 'ย้อนหลังกี่วัน (เดือนนี้ = 30)' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_sales',
      description:
        'บันทึกยอดขายรายวัน ใช้เมื่อผู้ใช้ส่งยอดขายมา (แยกตามสินค้า/ช่องทางได้) ' +
        '· ส่งยอดวันเดิม สินค้าเดิม ช่องทางเดิมซ้ำ = แก้ยอดเป็นค่าใหม่',
      parameters: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'วันที่ขาย YYYY-MM-DD (ค.ศ.) ไม่บอก = วันนี้ · "ยอดเมื่อวาน" = เมื่อวาน' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                product: { type: 'string', description: 'ชื่อสินค้า เขียนให้เหมือนเดิมทุกครั้ง' },
                amount: { type: 'number', description: 'ยอดเงิน บาท' },
                units: { type: 'number', description: 'จำนวนชิ้น (ถ้าบอก)' },
                channel: { type: 'string', description: 'ช่องทางขาย (ถ้าบอก) เช่น Facebook TikTok Shopee' },
              },
              required: ['product', 'amount'],
            },
          },
        },
        required: ['items'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'sales_report',
      description:
        'สรุปยอดขาย + เทรนด์สินค้าเป็น % รายวัน เทียบกับช่วงก่อนหน้า ใช้เมื่อถามยอดขาย ' +
        'สรุปยอด 7 วัน สินค้าไหนขึ้น/ลง สัดส่วนสินค้า',
      parameters: {
        type: 'object',
        properties: {
          days: { type: 'number', description: 'กี่วัน (ไม่บอก = 7 · วันเดียว = 1)' },
          end_date: { type: 'string', description: 'วันสุดท้ายของช่วง YYYY-MM-DD ไม่บอก = วันนี้' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'calendar',
      description:
        'ดูตารางนัดในปฏิทิน ใช้เมื่อถามว่าวันนี้/พรุ่งนี้/อาทิตย์นี้มีอะไร ติดอะไรไหม ว่างไหม',
      parameters: {
        type: 'object',
        properties: {
          days: { type: 'number', description: 'ดูกี่วัน 1 = วันเดียว, 7 = ทั้งอาทิตย์' },
          skip: { type: 'number', description: 'เริ่มนับจากอีกกี่วัน 0 = วันนี้, 1 = พรุ่งนี้' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'drive_search',
      description:
        'ค้นไฟล์ใน Google Drive ที่แชร์ให้เลขา ใช้เมื่อถามถึงไฟล์ เอกสาร ชีต หรือขอข้อมูลที่น่าจะอยู่ในไฟล์',
      parameters: {
        type: 'object',
        properties: { q: { type: 'string', description: 'คำค้น (ชื่อไฟล์หรือข้อความในไฟล์) เว้นว่าง = ไฟล์ล่าสุด' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'drive_read',
      description: 'อ่านเนื้อหาไฟล์ใน Drive (Google Docs, Sheets, ไฟล์ข้อความ) ใช้ id ที่ได้จาก drive_search',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'id ของไฟล์' } },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_groups',
      description: 'ดูรายชื่อกลุ่มที่เฝ้าอยู่ พร้อมการตั้งค่าของแต่ละกลุ่ม',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'config_group',
      description:
        'ตั้งค่าการเฝ้ากลุ่ม ใช้เมื่อเจ้าของสั่งเรื่องเวลารายงาน คำที่ต้องเตือน เวลารอตอบลูกค้า ' +
        'การเก็บออเดอร์ หรือสั่งให้หยุด/กลับมาเฝ้ากลุ่ม · พิมพ์ในกลุ่มไหน = ตั้งค่ากลุ่มนั้น ' +
        'ถ้าสั่งจากแชทส่วนตัวต้องบอกชื่อกลุ่มมาด้วย',
      parameters: {
        type: 'object',
        properties: {
          group: { type: 'string', description: 'ชื่อกลุ่ม (ใช้ตอนสั่งจากแชทส่วนตัว)' },
          report_hours: {
            type: 'array', items: { type: 'number' },
            description: 'ชั่วโมงที่ให้สรุป เวลาไทย 0-23 เช่น [9,17] = 9 โมงเช้ากับ 5 โมงเย็น',
          },
          add_alert_words: { type: 'array', items: { type: 'string' }, description: 'คำที่โผล่แล้วให้เตือนทันที' },
          remove_alert_words: { type: 'array', items: { type: 'string' }, description: 'คำที่ไม่ต้องเตือนแล้ว' },
          sla_minutes: { type: 'number', description: 'ลูกค้าถามแล้วเงียบกี่นาทีให้เตือน · 0 = ปิด' },
          track_orders: { type: 'boolean', description: 'สกัดออเดอร์จากกลุ่มนี้ด้วยไหม' },
          active: { type: 'boolean', description: 'false = หยุดเฝ้ากลุ่มนี้' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'summarize_group',
      description: 'สรุปบทสนทนาในกลุ่มนี้ตอนนี้เลย ใช้เมื่อผู้ใช้สั่งให้สรุปกลุ่ม',
      parameters: {
        type: 'object',
        properties: { hours: { type: 'number', description: 'ย้อนหลังกี่ชั่วโมง (ไม่บอก = 12)' } },
      },
    },
  },
];

// รันเครื่องมือ — ctx = { sourceId, userId, sourceType }
export async function applyTool(state, name, args, ctx = {}) {
  const now = new Date().toISOString();

  if (name === 'save_note') {
    const id = Math.max(0, ...state.notes.map((n) => n.id || 0)) + 1;
    state.notes.push({ id, text: args.text, at: now });
    return `บันทึกเป็นโน้ต #${id} แล้ว`;
  }

  if (name === 'forget_note') {
    const key = String(args.id ?? args.q ?? '').trim();
    if (!key) return 'บอกด้วยว่าจะให้ลืมอันไหน';
    const num = Number(key);
    const hit = Number.isInteger(num) && num > 0
      ? state.notes.filter((n) => n.id === num)
      : state.notes.filter((n) => n.text.toLowerCase().includes(key.toLowerCase()));

    if (!hit.length) return `ไม่เจอโน้ตที่ตรงกับ "${key}"`;
    // เจอหลายอันแล้วเดาให้ = ลบผิดแล้วกู้ไม่ได้ ให้ถามกลับดีกว่า
    if (hit.length > 1)
      return `เจอ ${hit.length} อัน ระบุให้ชัดกว่านี้:\n` + hit.map((n) => `#${n.id} ${n.text}`).join('\n');

    state.notes = state.notes.filter((n) => n !== hit[0]);
    return `ลืม "${hit[0].text}" แล้ว`;
  }

  if (name === 'search_history') {
    const days = Number(args.days) || 30;
    const keyword = (args.keyword || '').trim();
    const group = (args.group || '').trim();
    // อยู่ในกลุ่ม = ค้นได้เฉพาะกลุ่มนั้น ไม่งั้นเรื่องของกลุ่มอื่นจะรั่วออกไปต่อหน้าคนนอก
    const scope = ctx.sourceType === 'user' ? null : ctx.sourceId;

    const { rows } = await q(
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
    if (!rows.length)
      return `ไม่เจอข้อความ${keyword ? ` ที่มีคำว่า "${keyword}"` : ''}${group ? ` ในกลุ่ม ${group}` : ''} ใน ${days} วันล่าสุด`;

    return rows
      .reverse()
      .map((r) => {
        const at = new Date(r.ts).toLocaleString('th-TH', {
          timeZone: 'Asia/Bangkok', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
        });
        return `[${at}] ${r.title ? `${r.title} · ` : ''}${r.who ? `${r.who}: ` : ''}${r.text.slice(0, 200)}`;
      })
      .join('\n');
  }

  if (name === 'add_todo') {
    const id = (state.todos.at(-1)?.id ?? 0) + 1;
    state.todos.push({ id, text: args.text, due: toCE(args.due) || null, done: false, at: now });
    return `เพิ่มงาน #${id} แล้ว`;
  }

  if (name === 'done_todo') {
    const todo = state.todos.find((t) => t.id === Number(args.id) && !t.done);
    if (!todo) return `ไม่เจองาน #${args.id} ที่ยังค้างอยู่`;
    todo.done = true;
    return `ปิดงาน #${todo.id} "${todo.text}" แล้ว`;
  }

  if (name === 'add_expense') {
    await q('insert into expenses (user_id, amount, category, note, paid_at) values ($1,$2,$3,$4,now())', [
      ctx.userId, args.amount, args.category || null, args.note || null,
    ]);
    return `บันทึกรายจ่าย ${args.amount} บาทแล้ว`;
  }

  if (name === 'expense_summary') {
    const days = Number(args.days) || 30;
    const { rows } = await q(
      `select coalesce(category,'อื่น ๆ') as category, sum(amount) as total, count(*) as n
         from expenses where user_id = $1 and paid_at > now() - ($2 || ' days')::interval
        group by 1 order by total desc`,
      [ctx.userId, days]
    );
    if (!rows.length) return `ไม่มีรายจ่ายใน ${days} วันที่ผ่านมา`;
    const total = rows.reduce((s, r) => s + Number(r.total), 0);
    return `${days} วันล่าสุด รวม ${total.toLocaleString('th-TH')} บาท\n` +
      rows.map((r) => `${r.category} ${Number(r.total).toLocaleString('th-TH')} (${r.n} รายการ)`).join('\n');
  }

  if (name === 'add_sales') {
    const dateArg = toCE(args.date);
    const date = isDate(dateArg) ? dateArg : bkkDate();
    const items = (args.items || []).filter((i) => i?.product?.trim() && Number.isFinite(Number(i.amount)));
    if (!items.length) return 'ไม่มีรายการยอดขาย บอกชื่อสินค้ากับยอดเงินมาด้วย';
    for (const i of items) {
      await q(
        `insert into sales (user_id, sale_date, product, channel, amount, units) values ($1,$2,$3,$4,$5,$6)
         on conflict (user_id, sale_date, product, channel)
         do update set amount = excluded.amount, units = excluded.units, created_at = now()`,
        [ctx.userId, date, i.product.trim(), (i.channel || '').trim(), Number(i.amount), i.units == null ? null : Number(i.units)]
      );
    }
    const { rows: [d] } = await q(
      `select coalesce(sum(amount) filter (where sale_date = $2), 0) as today,
              coalesce(sum(amount) filter (where sale_date = $2::date - 1), 0) as prev
         from sales where user_id = $1 and sale_date between $2::date - 1 and $2::date`,
      [ctx.userId, date]
    );
    return `บันทึกยอด ${date} แล้ว ${items.length} รายการ · รวมวันนั้น ${baht(d.today)} บาท` +
      ` (เทียบวันก่อน ${pct(d.today, d.prev)})`;
  }

  if (name === 'sales_report') return salesReport(ctx.userId, args);

  if (name === 'calendar') {
    const days = Math.min(31, Math.max(1, Math.round(Number(args.days) || 1)));
    const skip = Math.max(0, Math.round(Number(args.skip) || 0));
    const label = skip === 0 && days === 1 ? 'วันนี้' : skip === 1 && days === 1 ? 'พรุ่งนี้' : `${days} วันข้างหน้า`;
    // มี service account = ถาม Google ตรง ๆ (แม่นกว่า รู้ว่านัดไหนถูกยกเลิก) · ไม่มีก็ถอยไปอ่านลิงก์ iCal
    try {
      const list = (await events({ days, skip })) ?? (await agenda({ days, skip }));
      return agendaText(list, label);
    } catch (err) {
      return `เปิดปฏิทินไม่ได้: ${err.message}`;
    }
  }

  if (name === 'drive_search') {
    try {
      const files = await driveSearch(args.q);
      if (files === null) return 'ยังไม่ได้ต่อ Google Drive';
      if (!files.length) return `ไม่เจอไฟล์${args.q ? ` ที่ตรงกับ "${args.q}"` : ''} (เห็นเฉพาะที่แชร์ให้เลขาเท่านั้น)`;
      return files
        .map((f) => {
          const kind = f.mimeType?.includes('spreadsheet') ? 'ชีต'
            : f.mimeType?.includes('document') ? 'เอกสาร'
            : f.mimeType?.includes('folder') ? 'โฟลเดอร์' : 'ไฟล์';
          const when = new Date(f.modifiedTime).toLocaleDateString('th-TH', { timeZone: 'Asia/Bangkok', day: 'numeric', month: 'short' });
          return `${kind}: ${f.name} · แก้ล่าสุด ${when} · id ${f.id}`;
        })
        .join('\n');
    } catch (err) {
      return `ค้น Drive ไม่ได้: ${err.message}`;
    }
  }

  if (name === 'drive_read') {
    try {
      const file = await driveRead(args.id);
      if (!file) return 'ยังไม่ได้ต่อ Google Drive';
      return file.text ? `📄 ${file.name}\n\n${file.text}` : `${file.name}: ${file.note}`;
    } catch (err) {
      return `อ่านไฟล์ไม่ได้: ${err.message}`;
    }
  }

  if (name === 'list_groups') {
    const { rows } = await q('select * from watched order by active desc, title');
    if (!rows.length) return 'ยังไม่ได้เฝ้ากลุ่มไหนเลย — เชิญผมเข้ากลุ่มได้เลย';
    return rows
      .map((g) =>
        [
          `${g.active ? '👀' : '⏸'} ${g.title || g.source_id.slice(0, 10) + '…'}`,
          `สรุป ${g.report_hours.join(', ')} โมง`,
          g.sla_minutes ? `เตือนถามค้าง ${g.sla_minutes} นาที` : 'ไม่เตือนถามค้าง',
          g.track_orders ? 'เก็บออเดอร์' : null,
          `คำเตือน: ${g.alert_words?.join(' ') || 'ไม่มี'}`,
        ].filter(Boolean).join(' · ')
      )
      .join('\n');
  }

  if (name === 'config_group') {
    const target = await findGroup(args.group, ctx);
    if (typeof target === 'string') return target; // หาไม่เจอ/กำกวม — ข้อความบอกเหตุผล
    const g = target;

    const set = [];
    const vals = [];
    const changed = [];
    const put = (col, val, msg) => {
      vals.push(val);
      set.push(`${col} = $${vals.length}`);
      changed.push(msg);
    };

    if (Array.isArray(args.report_hours)) {
      const hours = [...new Set(args.report_hours.map(Number))]
        .filter((h) => Number.isInteger(h) && h >= 0 && h <= 23)
        .sort((a, b) => a - b);
      if (hours.length) put('report_hours', hours, `สรุปตอน ${hours.join(', ')} โมง`);
    }
    if (args.add_alert_words?.length || args.remove_alert_words?.length) {
      const drop = (args.remove_alert_words || []).map((w) => w.trim());
      const words = [...new Set([...(g.alert_words || []), ...(args.add_alert_words || []).map((w) => w.trim())])]
        .filter((w) => w && !drop.includes(w));
      put('alert_words', words, `คำเตือน: ${words.join(' ') || 'ไม่มีแล้ว'}`);
    }
    if (args.sla_minutes != null) {
      const m = Math.max(0, Math.round(Number(args.sla_minutes) || 0));
      put('sla_minutes', m, m ? `เตือนเมื่อถามค้างเกิน ${m} นาที` : 'ปิดการเตือนถามค้าง');
    }
    if (args.track_orders != null)
      put('track_orders', !!args.track_orders, args.track_orders ? 'เก็บออเดอร์จากกลุ่มนี้' : 'ไม่เก็บออเดอร์แล้ว');
    if (args.active != null) put('active', !!args.active, args.active ? 'กลับมาเฝ้ากลุ่มนี้' : 'หยุดเฝ้ากลุ่มนี้');

    if (!set.length) return 'ไม่มีอะไรให้เปลี่ยน บอกมาว่าจะตั้งอะไร';
    vals.push(g.source_id);
    await q(`update watched set ${set.join(', ')} where source_id = $${vals.length}`, vals);
    return `ตั้งค่ากลุ่ม ${g.title || 'นี้'} แล้ว — ${changed.join(' · ')}`;
  }

  if (name === 'summarize_group') {
    if (ctx.sourceType === 'user') return 'สรุปกลุ่มได้เฉพาะตอนสั่งในกลุ่มนั้นครับ';
    const hours = Number(args.hours) || 12;
    const { rows } = await q(
      `select text, ts from messages
        where source_id = $1 and text is not null and ts > now() - ($2 || ' hours')::interval
        order by ts limit 500`,
      [ctx.sourceId, hours]
    );
    if (rows.length < 2) return `ไม่มีบทสนทนาใน ${hours} ชั่วโมงที่ผ่านมา`;
    return await summarize('', rows);
  }

  return `ไม่รู้จักเครื่องมือ ${name}`;
}

// หากลุ่มที่จะตั้งค่า: อยู่ในกลุ่มก็คือกลุ่มนั้น · อยู่ในแชทส่วนตัวต้องบอกชื่อ (เว้นแต่เฝ้าอยู่กลุ่มเดียว)
async function findGroup(name, ctx) {
  if (ctx.sourceType && ctx.sourceType !== 'user') {
    const { rows } = await q('select * from watched where source_id = $1', [ctx.sourceId]);
    return rows[0] || 'กลุ่มนี้ยังไม่อยู่ในทะเบียน ลองพิมพ์อะไรในกลุ่มสักข้อความก่อน';
  }
  if (name?.trim()) {
    const { rows } = await q(`select * from watched where title ilike '%' || $1 || '%'`, [name.trim()]);
    if (!rows.length) return `ไม่เจอกลุ่มชื่อ "${name}"`;
    if (rows.length > 1) return `เจอหลายกลุ่ม: ${rows.map((r) => r.title).join(' / ')} — ระบุให้ชัดกว่านี้`;
    return rows[0];
  }
  const { rows } = await q('select * from watched where active');
  if (rows.length === 1) return rows[0];
  return rows.length ? 'บอกชื่อกลุ่มด้วย หรือไปพิมพ์สั่งในกลุ่มนั้นเลย' : 'ยังไม่ได้เฝ้ากลุ่มไหนเลย';
}

// ── ยอดขาย ─────────────────────────────────────────────────────────────
// วันที่เก็บเป็น YYYY-MM-DD เวลาไทย (เซิร์ฟเวอร์เดิน UTC — ตี 1 บ้านเรายังเป็นเมื่อวานของเซิร์ฟเวอร์)
export const bkkDate = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
export const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '') && !isNaN(Date.parse(s));
const short = (d) => `${d.slice(8)}/${d.slice(5, 7)}`;
const baht = (n) => Math.round(Number(n)).toLocaleString('th-TH');
const share = (a, total) => `${total ? Math.round((a / total) * 100) : 0}%`;
function pct(a, b) {
  a = Number(a);
  b = Number(b);
  if (!b) return a ? 'ใหม่' : '—';
  const p = ((a - b) / b) * 100;
  return `${p >= 0 ? '+' : ''}${p.toFixed(1)}%`;
}

// สรุปยอด N วัน: รวม · เทียบช่วงก่อน · รายวัน (เทียบวันก่อน + สัดส่วนสินค้า) · ตามสินค้า (ขึ้น/ลง)
export async function salesReport(userId, args = {}) {
  const days = Math.min(31, Math.max(1, Math.round(Number(args.days) || 7)));
  const endArg = toCE(args.end_date);
  const end = isDate(endArg) ? endArg : bkkDate();
  const start = addDays(end, -(days - 1));
  // ดึงช่วงก่อนหน้ามาด้วย ไว้เทียบ % ในคำสั่งเดียว
  const { rows } = await q(
    `select sale_date::text as d, product, sum(amount)::float8 as amount
       from sales where user_id = $1 and sale_date between $2 and $3
      group by 1, 2 order by 1, 2`,
    [userId, addDays(start, -days), end]
  );
  const cur = rows.filter((r) => r.d >= start);
  const prev = rows.filter((r) => r.d < start);
  if (!cur.length)
    return `ยังไม่มียอดขายช่วง ${short(start)}–${short(end)} — ส่งยอดมาได้เลย เช่น "ยอดวันนี้ สินค้า A 12,000"`;

  const sum = (list) => list.reduce((s, r) => s + r.amount, 0);
  const total = sum(cur);
  const byDay = new Map();
  for (const r of cur) byDay.set(r.d, [...(byDay.get(r.d) || []), r]);

  const daily = [...byDay].map(([d, list]) => {
    const t = sum(list);
    const mix = [...list].sort((a, b) => b.amount - a.amount).map((r) => `${r.product} ${share(r.amount, t)}`).join(' · ');
    return `${short(d)} ${baht(t)} (${pct(t, sum(rows.filter((r) => r.d === addDays(d, -1))))}) — ${mix}`;
  });

  // สัดส่วนวันล่าสุดเทียบสัดส่วนเฉลี่ยทั้งช่วง → บอกว่าสินค้ากำลังขึ้นหรือลง
  const last = byDay.get([...byDay.keys()].at(-1));
  const lastTotal = sum(last);
  const perProduct = [...new Set(cur.map((r) => r.product))]
    .map((p) => {
      const a = sum(cur.filter((r) => r.product === p));
      const avgShare = (a / total) * 100;
      const lastShare = lastTotal ? (sum(last.filter((r) => r.product === p)) / lastTotal) * 100 : 0;
      const arrow = lastShare - avgShare > 3 ? '↑' : avgShare - lastShare > 3 ? '↓' : '→';
      return {
        a,
        line: `${p} ${baht(a)} (${share(a, total)}) · เทียบช่วงก่อน ${pct(a, sum(prev.filter((r) => r.product === p)))}` +
          ` · สัดส่วนวันล่าสุด ${lastShare.toFixed(0)}% ${arrow}`,
      };
    })
    .sort((x, y) => y.a - x.a)
    .map((x) => x.line);

  return [
    `ยอดขาย ${days} วัน (${short(start)}–${short(end)}) รวม ${baht(total)} บาท · เทียบ ${days} วันก่อน ${pct(total, sum(prev))}`,
    `เฉลี่ยวันละ ${baht(total / byDay.size)} บาท (มียอด ${byDay.size}/${days} วัน)`,
    '',
    'รายวัน (เทียบวันก่อน · สัดส่วนสินค้า):',
    ...daily,
    '',
    'ตามสินค้า:',
    ...perProduct,
  ].join('\n');
}

function systemPrompt(state, ctx) {
  const time = new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit' });
  // ปฏิทิน 7 วันข้างหน้าแบบ ค.ศ. พร้อมชื่อวัน — โมเดลบางตัวนับ "ศุกร์นี้" เองแล้วพลาด หรือใส่ปี พ.ศ. ลงช่อง due
  const week = Array.from({ length: 8 }, (_, i) => {
    const d = addDays(bkkDate(), i);
    const day = new Date(`${d}T12:00:00Z`).toLocaleDateString('th-TH', { weekday: 'long', timeZone: 'UTC' });
    return `${d} ${day}${i === 0 ? ' (วันนี้)' : i === 1 ? ' (พรุ่งนี้)' : ''}`;
  });
  const open = state.todos.filter((t) => !t.done);
  return [
    PERSONA, // ← หน้าที่และบุคลิกของบอท แก้ได้ที่ lib/persona.js
    `ตอนนี้ ${time} น. เวลาไทย · ปฏิทิน (ค.ศ.):\n${week.join('\n')}`,
    'วันที่ในเครื่องมือทุกตัวต้องเป็น ค.ศ. แบบ YYYY-MM-DD ดูจากปฏิทินข้างบน ห้ามนับเอง',
    ctx.sourceType === 'user' ? 'กำลังคุยแบบส่วนตัว' : 'กำลังอยู่ในกลุ่ม — ตอบสั้นกว่าปกติ',
    'ถ้าผู้ใช้บอกอะไรที่ควรจำ หรือสั่งงาน ให้เรียกเครื่องมือทันทีโดยไม่ต้องถามซ้ำ',
    hasCalendar() || hasGoogle() ? 'มีปฏิทินให้ดูด้วย ถามเรื่องนัดเมื่อไหร่ให้เปิดปฏิทินดูก่อนตอบ' : '',
    hasGoogle() ? 'มี Google Drive ให้ค้นด้วย ถามถึงไฟล์/เอกสาร/ตัวเลขที่น่าจะอยู่ในไฟล์ ให้ค้นก่อนตอบ อย่าเดา' : '',
    'ข้อมูลที่ผู้ใช้เคยบอกไว้ (ตอบจากนี่ได้เลย ไม่ต้องเรียกเครื่องมือ):',
    `โน้ต: ${state.notes.map((n) => `#${n.id} ${n.text}`).join('\n') || '(ยังไม่มี)'}`,
    `งานค้าง: ${open.map((t) => `#${t.id} ${t.text}${t.due ? ` (ครบ ${t.due})` : ''}`).join('\n') || '(ไม่มี)'}`,
  ].join('\n');
}

async function chat(messages, useTools = true, model = MODEL) {
  const res = await fetch(`${OR}/chat/completions`, {
    method: 'POST',
    headers: auth(),
    body: JSON.stringify({ model, messages, ...(useTools && { tools: TOOLS }) }),
  });
  if (!res.ok) throw new Error(`openrouter ${res.status}: ${await res.text()}`);
  return (await res.json()).choices[0].message;
}

// คุย 1 รอบ: AI คิด → ถ้าขอใช้เครื่องมือก็รันแล้วส่งผลกลับ → ได้คำตอบเป็นภาษาคน
export async function think(state, userText, ctx = {}) {
  const messages = [
    { role: 'system', content: systemPrompt(state, ctx) },
    ...state.chat,
    { role: 'user', content: userText },
  ];

  for (let i = 0; i < 4; i++) {
    const msg = await chat(messages);
    messages.push(msg);
    if (!msg.tool_calls?.length) {
      const answer = plain(msg.content) || 'รับทราบครับ';
      state.chat = [...state.chat, { role: 'user', content: userText }, { role: 'assistant', content: answer }].slice(-CHAT_MEMORY);
      return answer;
    }
    for (const call of msg.tool_calls) {
      let args = {};
      try {
        args = JSON.parse(call.function.arguments || '{}');
      } catch {}
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: await applyTool(state, call.function.name, args, ctx),
      });
    }
  }
  return 'ทำงานวนไม่จบ ลองพิมพ์ใหม่อีกทีนะครับ';
}

// LINE ไม่แสดง markdown — โมเดลสั่งแล้วก็ยังหลุด ** มาบ่อย เลยลอกออกอีกชั้น
export const plain = (s) =>
  (s || '').replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1').replace(/^#{1,6}\s+/gm, '').trim();

// สรุปบทสนทนาในกลุ่ม
export async function summarize(title, rows) {
  const lines = rows.map((r) => {
    const at = new Date(r.ts).toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit' });
    return `[${at}] ${r.who ? `${r.who}: ` : ''}${r.text}`; // r.who = ชื่อคนพูด (jobs.js เติมให้) ไม่มีก็ข้ามไป
  });
  const msg = await chat(
    [
      {
        role: 'system',
        content: [
          'สรุปบทสนทนาในกลุ่ม LINE ให้เจ้านายที่ไม่ได้อ่านเอง ภาษาไทย',
          'รูปแบบ: 3-5 บรรทัดว่าคุยอะไรกัน แล้วขึ้นบรรทัด "ต้องทำ:" ตามด้วยสิ่งที่ต้องตัดสินใจ/ตอบ/ทำ (ถ้าไม่มีให้เขียนว่า ไม่มี)',
          'ข้อความที่มีชื่อคนนำหน้า ให้อ้างชื่อนั้นในสรุปด้วย เช่น "เอถามราคา รอตอบ" ไม่ใช่ "มีคนถามราคา"',
          'ห้ามแต่งเติมสิ่งที่ไม่มีในบทสนทนา ถ้าคุยเล่นล้วน ๆ ก็บอกตรง ๆ ว่าไม่มีสาระที่ต้องทำ',
        ].join('\n'),
      },
      { role: 'user', content: `กลุ่ม "${title || 'ไม่มีชื่อ'}" ${rows.length} ข้อความ:\n${lines.join('\n')}` },
    ],
    false
  );
  return plain(msg.content) || '(สรุปไม่สำเร็จ)';
}

// อ่านสลิปโอนเงินจากรูป → JSON
export async function readSlip(base64) {
  const msg = await chat(
    [
      {
        role: 'system',
        content:
          'อ่านสลิปโอนเงิน/ใบเสร็จ ตอบเป็น JSON เท่านั้น ไม่ต้องมี markdown: ' +
          '{"is_slip":true/false,"amount":ตัวเลข,"bank":"ธนาคาร/ร้าน","ref":"เลขอ้างอิง","paid_at":"YYYY-MM-DD HH:mm","category":"หมวด","confidence":0-1} ' +
          'paid_at ต้องเป็น ค.ศ. เสมอ — สลิปไทยมักเขียน พ.ศ. (เช่น 2569) ให้ลบ 543 ก่อน ' +
          'อ่านไม่ออกช่องไหนให้ใส่ null · ไม่ใช่สลิปให้ is_slip=false',
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'สลิปนี้จ่ายเท่าไหร่' },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } },
        ],
      },
    ],
    false,
    VISION_MODEL
  );
  try {
    const slip = JSON.parse(msg.content.replace(/```json?|```/g, '').trim());
    slip.paid_at = toCE(slip.paid_at);
    return slip;
  } catch {
    return { is_slip: false };
  }
}

// สลิปไทยเขียนปี พ.ศ. — บอกใน prompt แล้วแต่โมเดลก็ยังหลุดบ่อย เลยกันอีกชั้น
export function toCE(date) {
  if (!date) return null;
  const m = String(date).match(/^(\d{4})(.*)$/);
  if (!m) return date;
  const year = Number(m[1]);
  // ปีที่มากกว่าปีนี้ 10 ปี = พ.ศ. แน่ ๆ (ไม่มีใครจ่ายเงินล่วงหน้า 10 ปี)
  return year > new Date().getFullYear() + 10 ? `${year - 543}${m[2]}` : date;
}

// กำหนดส่งที่ AI จดไว้เป็นเวลาไทยเสมอ แต่เซิร์ฟเวอร์ Vercel เดินเป็น UTC
// ถ้าไม่ต่อ +07:00 ให้ "พรุ่งนี้ 10 โมง" จะกลายเป็น 17:00 บ้านเรา = เตือนช้าไป 7 ชั่วโมง
export function dueTime(due) {
  if (!due) return null;
  let s = String(due).trim().replace(' ', 'T');
  if (!/T/.test(s)) s += 'T09:00'; // บอกมาแค่วัน = เตือนเช้า 9 โมง
  if (!/[+-]\d{2}:?\d{2}$|Z$/.test(s)) s += '+07:00';
  const t = new Date(s);
  return isNaN(t) ? null : t;
}

// ถอดเสียงที่ผู้ใช้ส่งมา (LINE ส่งมาเป็น m4a)
// มี ELEVENLABS_API_KEY = ใช้ Scribe (แม่นภาษาไทยกว่า) · ไม่มี = Whisper ผ่าน OpenRouter key เดิม
export async function transcribe(base64, format = 'm4a') {
  if (process.env.ELEVENLABS_API_KEY) return scribe(base64, format);

  const res = await fetch(`${OR}/audio/transcriptions`, {
    method: 'POST',
    headers: auth(),
    body: JSON.stringify({ model: STT_MODEL, input_audio: { data: base64, format } }),
  });
  if (!res.ok) throw new Error(`stt ${res.status}: ${await res.text()}`);
  return (await res.json()).text?.trim() || '';
}

async function scribe(base64, format) {
  const form = new FormData();
  form.append('file', new Blob([Buffer.from(base64, 'base64')]), `audio.${format}`);
  form.append('model_id', process.env.ELEVENLABS_STT_MODEL || 'scribe_v1');
  const res = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
    method: 'POST',
    headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY },
    body: form,
  });
  if (!res.ok) throw new Error(`scribe ${res.status}: ${await res.text()}`);
  return (await res.json()).text?.trim() || '';
}

// สกัดออเดอร์จากข้อความในกลุ่มสั่งของ
export async function extractOrders(rows) {
  const msg = await chat(
    [
      {
        role: 'system',
        content:
          'ดึงเฉพาะข้อความที่เป็นการสั่งซื้อออกมา ตอบเป็น JSON array เท่านั้น ไม่ต้องมี markdown: ' +
          '[{"i":ลำดับข้อความ,"customer":"ชื่อ/null","items":["รายการ"],"amount":ยอดรวมถ้ามีไม่งั้น null}] ' +
          'ข้อความที่ไม่ใช่การสั่งของ ไม่ต้องใส่ · ไม่มีเลยตอบ []',
      },
      { role: 'user', content: rows.map((r, i) => `${i}. ${r.text}`).join('\n') },
    ],
    false
  );
  try {
    return JSON.parse(msg.content.replace(/```json?|```/g, '').trim());
  } catch {
    return [];
  }
}
