// ส่งค่าจาก .env.local ขึ้น Vercel หรือ Railway ทีเดียวทั้งชุด
//   node scripts/push-env.mjs vercel
//   node scripts/push-env.mjs railway
// ค่าถูกส่งผ่าน stdin ไม่โผล่ในบรรทัดคำสั่ง (ปลอดภัยตอนแชร์จอ/อัดคลิป)
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const target = process.argv[2];
if (!['vercel', 'railway', 'pull'].includes(target)) {
  console.log('ใช้: node scripts/push-env.mjs vercel|railway|pull');
  console.log('  pull = ดึงค่าที่ Vercel สร้างให้ (เช่น DATABASE_URL ของ Neon) ลงมาใส่ .env.local');
  process.exit(1);
}

// ── ดึงค่าจาก Vercel ลงมาเติม .env.local โดยไม่ทับค่าที่มีอยู่
// (ห้ามใช้ `vercel env pull .env.local` ตรง ๆ เพราะมันเขียนทับทั้งไฟล์ ค่าที่ยังไม่ได้ push จะหายหมด)
if (target === 'pull') {
  const tmp = '.env.from-vercel';
  const r = spawnSync('npx', ['vercel@latest', 'env', 'pull', tmp, '--yes'], { encoding: 'utf8', stdio: 'inherit' });
  if (r.status !== 0) {
    console.log('❌ ดึงค่าจาก Vercel ไม่สำเร็จ — ล็อกอินและ deploy ไปแล้วหรือยัง');
    process.exit(1);
  }
  const pulled = fs.readFileSync(tmp, 'utf8');
  let local = fs.existsSync('.env.local') ? fs.readFileSync('.env.local', 'utf8') : '';
  let added = 0;

  for (const key of ['DATABASE_URL', 'POSTGRES_URL']) {
    const m = pulled.match(new RegExp(`^${key}\\s*=\\s*(.+)$`, 'm'));
    if (!m) continue;
    const value = m[1].trim().replace(/^["']|["']$/g, '');
    if (!value || value.includes('...')) continue;
    // มีบรรทัดนี้อยู่แล้ว (อาจว่างหรือเป็นตัวอย่าง) → แทนที่ ไม่มี → เติมท้าย
    local = new RegExp(`^${key}\\s*=.*$`, 'm').test(local)
      ? local.replace(new RegExp(`^${key}\\s*=.*$`, 'm'), `${key}=${value}`)
      : `${local.replace(/\n*$/, '')}\n${key}=${value}\n`;
    console.log(`✅ ได้ ${key} จาก Vercel แล้ว`);
    added++;
    break; // เอาตัวเดียวพอ DATABASE_URL มาก่อน
  }

  fs.writeFileSync('.env.local', local);
  fs.unlinkSync(tmp);
  if (!added) {
    console.log('❌ ไม่เจอ DATABASE_URL บน Vercel — สร้าง Neon ในหน้า Vercel → Storage แล้วหรือยัง');
    process.exit(1);
  }
  console.log('ค่าอื่นใน .env.local ไม่ถูกแตะ');
  process.exit(0);
}

if (!fs.existsSync('.env.local')) {
  console.log('❌ ไม่มีไฟล์ .env.local');
  process.exit(1);
}

const KEYS = [
  'LINE_CHANNEL_ACCESS_TOKEN',
  'LINE_CHANNEL_SECRET',
  'LINE_CHANNEL_ID',
  'OPENROUTER_API_KEY',
  'OPENROUTER_MODEL',
  'OPENROUTER_VISION_MODEL',
  'DATABASE_URL',
  'DASHBOARD_KEY',
  'CRON_SECRET',
  'OWNER_USER_ID',
  'ELEVENLABS_API_KEY',
  'BOT_NAME',
  'PERSONA',
  'DASHBOARD_PUBLIC',
  'CRON_FREQUENT',
  'REPLY_TO_ALL',
  'DASHBOARD_URL',
  'CHAT_MEMORY',
  'CALENDAR_ICS_URL',
  'GOOGLE_SERVICE_ACCOUNT',
  'GOOGLE_CALENDAR_ID',
  'SILENT_JOIN',
  'GROUP_SILENT',
];

const env = {};
for (const line of fs.readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}

let done = 0;
for (const key of KEYS) {
  const value = env[key];
  if (!value) continue; // ตัวที่ไม่ได้ใส่ก็ข้าม (เช่น ELEVENLABS_API_KEY)

  const [cmd, args] =
    target === 'vercel'
      ? ['npx', ['vercel@latest', 'env', 'add', key, 'production', '--force', '--sensitive', '-y']]
      : ['npx', ['@railway/cli@latest', 'variable', 'set', key, '--stdin', '--skip-deploys']];

  const r = spawnSync(cmd, args, { input: value, encoding: 'utf8' });
  if (r.status === 0) {
    console.log(`✅ ${key}`);
    done++;
  } else {
    // ตัดค่าที่อาจหลุดมากับ error ออกก่อนแสดง
    const msg = (r.stderr || r.stdout || '').split('\n').filter((l) => l.trim() && !l.includes(value))[0] || 'ไม่ทราบสาเหตุ';
    console.log(`❌ ${key} — ${msg.slice(0, 120)}`);
  }
}

console.log(`\nส่งขึ้น ${target} แล้ว ${done} ค่า`);
if (target === 'vercel') console.log('อย่าลืม deploy ซ้ำให้ค่ามีผล:  npx vercel@latest --prod --yes');
