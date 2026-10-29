"""
25nail - Flask backend (เวอร์ชันแก้ไขความปลอดภัยและบั๊ก)

ตั้งค่าก่อนรัน (ตัวแปรสภาพแวดล้อม):
    ADMIN_PASSWORD   รหัสผ่านแอดมิน (จำเป็น ถ้าไม่ตั้งจะล็อกอินแอดมินไม่ได้)
    SECRET_KEY       กุญแจเซสชัน (ไม่ตั้งก็ได้ ระบบจะสร้างไฟล์ .secret_key ให้)
    PROMPTPAY_ID     เบอร์พร้อมเพย์ (ค่าเริ่มต้น 0946486003)
    HTTPS=1          ถ้าใช้ HTTPS จริง ให้ตั้งเพื่อเปิด Secure cookie
    FLASK_DEBUG=1    เปิด debug เฉพาะตอนพัฒนาบนเครื่องตัวเองเท่านั้น
"""
import os
import re
import json
import math
import time
import secrets
import shutil
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from functools import wraps
from urllib.parse import urlparse

from flask import (Flask, render_template, request, jsonify, session,
                   send_from_directory, abort)
from werkzeug.exceptions import HTTPException
from werkzeug.security import generate_password_hash, check_password_hash

# ---------------------------------------------------------------- ค่าคงที่
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_NAME = os.path.join(BASE_DIR, 'database.db')
PUBLIC_UPLOAD_DIR = os.path.join(BASE_DIR, 'static', 'uploads')   # รูปสินค้า/รีวิว (เปิดสาธารณะ)
PRIVATE_UPLOAD_DIR = os.path.join(BASE_DIR, 'private_uploads')    # สลิป/รูปแบบเล็บ (ต้องล็อกอิน)
PUBLIC_UPLOAD_URL = 'static/uploads'

SHOP_PROVINCE = 'ขอนแก่น'
SHOP_ADDRESS = 'เข้ารับบริการที่ร้าน (ซอยโต้งพรรณา ต.ในเมือง อ.เมือง จ.ขอนแก่น)'
PROMPTPAY_ID = os.environ.get('PROMPTPAY_ID', '0946486003')

DEPOSIT_AMOUNT = 100.0
VAT_RATE = 0.07
FREE_SHIPPING_THRESHOLD = 1500.0
SHIPPING_IN_PROVINCE = 50.0
SHIPPING_OUT_PROVINCE = 100.0
CUSTOM_PLACEHOLDER_PRICE = 350.0
CLOSING_HOUR = 21            # บริการต้องเสร็จก่อน 21:00
MAX_BOOKING_DAYS_AHEAD = 180

# ชั่วโมงที่ใช้ต่อบริการ (ใช้ที่เดียว ส่งให้ฝั่งเว็บผ่าน /api/config)
SERVICE_DURATIONS = {
    'บริการต่อเล็บเจล + เพ้นท์ลาย': 2,
    'ถอดเล็บ + ทำบำรุง': 1,
    'บริการต่อเล็บเจล + ติดอะไหล่': 3,
    'ทาสีพื้น': 1,
}

REVIEW_CODES = ('CORE APPLY', 'REVIEW5')
ACTIVE_STATUSES = ('confirmed', 'pending_booking_approval', 'pending_presson_approval')
DELIVERY_STATUSES = ('กำลังเตรียมจัดส่ง', 'กำลังจัดส่ง', 'ส่งเรียบร้อย')
SERVICE_CATEGORIES = ('custom', 'booking')

THAI_TZ = timezone(timedelta(hours=7))
TS_FORMAT = '%Y-%m-%d %H:%M:%S'

# ---------------------------------------------------------------- สร้างแอป
app = Flask(__name__)
app.config['MAX_CONTENT_LENGTH'] = 8 * 1024 * 1024   # 8 MB ต่อคำขอ
app.config['SESSION_COOKIE_HTTPONLY'] = True
app.config['SESSION_COOKIE_SAMESITE'] = 'Lax'
app.config['SESSION_COOKIE_SECURE'] = os.environ.get('HTTPS') == '1'
app.config['PERMANENT_SESSION_LIFETIME'] = timedelta(days=30)
app.config['JSON_AS_ASCII'] = False

os.makedirs(PUBLIC_UPLOAD_DIR, exist_ok=True)
os.makedirs(PRIVATE_UPLOAD_DIR, exist_ok=True)


def _load_secret_key():
    env_key = os.environ.get('SECRET_KEY')
    if env_key:
        return env_key
    key_file = os.path.join(BASE_DIR, '.secret_key')
    if os.path.exists(key_file):
        with open(key_file, 'r') as f:
            return f.read().strip()
    key = secrets.token_hex(32)
    with open(key_file, 'w') as f:
        f.write(key)
    try:
        os.chmod(key_file, 0o600)
    except OSError:
        pass
    return key


app.secret_key = _load_secret_key()

from dotenv import load_dotenv
load_dotenv()
_admin_password = os.environ.get('ADMIN_PASSWORD')
ADMIN_PASSWORD_HASH = generate_password_hash(_admin_password) if _admin_password else None
if not ADMIN_PASSWORD_HASH:
    app.logger.warning('ยังไม่ได้ตั้ง ADMIN_PASSWORD จึงไม่สามารถล็อกอินแอดมินได้')
del _admin_password


# ---------------------------------------------------------------- เครื่องมือทั่วไป
def now_th():
    """เวลาไทย (naive) ใช้ทั้งระบบ"""
    return datetime.now(THAI_TZ).replace(tzinfo=None)


def now_str():
    return now_th().strftime(TS_FORMAT)


def ok(**kwargs):
    payload = {'status': 'success'}
    payload.update(kwargs)
    return jsonify(payload), 200


def fail(message, code=400):
    return jsonify({'status': 'error', 'message': message}), code


def round2(value):
    return round(float(value) + 1e-9, 2)


@contextmanager
def db():
    conn = sqlite3.connect(DB_NAME, timeout=10)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def mask_name(name):
    """ปิดชื่อเพื่อแสดงสาธารณะ (ผลลัพธ์เดิมถูกปิดซ้ำได้โดยไม่เปลี่ยน)"""
    if not name:
        return 'ลูกค้า'
    name = name.strip()
    parts = name.split()
    if len(parts) > 1:
        return f"{parts[0][0]}*** {parts[1][0]}***"
    if len(name) <= 2:
        return f"{name[0]}***"
    return f"{name[:2]}***"


app.jinja_env.filters['mask_name'] = mask_name


# ---------------------------------------------------------------- ฐานข้อมูล
def ensure_column(c, table, column, decl):
    cols = [r['name'] for r in c.execute(f'PRAGMA table_info({table})')]
    if column not in cols:
        c.execute(f'ALTER TABLE {table} ADD COLUMN {column} {decl}')
        return True
    return False


def _move_legacy_file(path_value):
    """ย้ายไฟล์สลิปเก่า (เดิมอยู่ใน static/) ไปโฟลเดอร์ส่วนตัว คืนชื่อไฟล์ใหม่
    รองรับค่าเก่าหลายแบบ เช่น 'static/uploads/x.jpg' และ 'uploads\\x.jpg' (path แบบ Windows)"""
    if not path_value:
        return path_value
    normalized = path_value.replace('\\', '/')
    name = os.path.basename(normalized)
    if os.path.exists(os.path.join(PRIVATE_UPLOAD_DIR, name)) and normalized == name:
        return name
    candidates = [
        os.path.join(BASE_DIR, normalized),
        os.path.join(BASE_DIR, 'static', normalized),
        os.path.join(PUBLIC_UPLOAD_DIR, name),
    ]
    for src in candidates:
        if os.path.isfile(src):
            dst = os.path.join(PRIVATE_UPLOAD_DIR, name)
            if os.path.exists(dst):
                name = f'{secrets.token_hex(4)}_{name}'
                dst = os.path.join(PRIVATE_UPLOAD_DIR, name)
            shutil.move(src, dst)
            break
    return name


def init_db():
    with db() as conn:
        c = conn.cursor()

        c.execute('''CREATE TABLE IF NOT EXISTS services
                     (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, price REAL, category TEXT,
                      image_path TEXT DEFAULT '', display_order INTEGER DEFAULT 0)''')
        c.execute('''CREATE TABLE IF NOT EXISTS queues
                     (id INTEGER PRIMARY KEY AUTOINCREMENT,
                      name TEXT, fname TEXT, lname TEXT, ig_line TEXT, phone TEXT,
                      service TEXT, date TEXT, time TEXT, slip_path TEXT,
                      size TEXT, custom_img_path TEXT, status TEXT DEFAULT 'confirmed',
                      price REAL, address TEXT, shipping_fee REAL DEFAULT 0, discount REAL DEFAULT 0,
                      vat REAL DEFAULT 0, delivery_status TEXT DEFAULT 'กำลังเตรียมจัดส่ง',
                      tracking_number TEXT DEFAULT '-', coupon_code TEXT DEFAULT '',
                      created_at TEXT, archived INTEGER DEFAULT 0, order_type TEXT)''')
        c.execute('''CREATE TABLE IF NOT EXISTS users
                     (id INTEGER PRIMARY KEY AUTOINCREMENT,
                      fname TEXT, lname TEXT, ig_line TEXT, phone TEXT UNIQUE, password TEXT,
                      has_reviewed INTEGER DEFAULT 0)''')
        c.execute('''CREATE TABLE IF NOT EXISTS reviews
                     (id INTEGER PRIMARY KEY AUTOINCREMENT,
                      phone TEXT, name TEXT, rating INTEGER, comment TEXT, image_path TEXT,
                      created_at TEXT)''')

        c.execute('''CREATE TABLE IF NOT EXISTS sales_adjustments
                     (period TEXT PRIMARY KEY, amount REAL NOT NULL, updated_at TEXT NOT NULL)''')

        # คอลัมน์ที่ DB เก่าอาจยังไม่มี (ไม่กลืน error เงียบ ๆ อีกต่อไป)
        ensure_column(c, 'services', 'display_order', 'INTEGER DEFAULT 0')
        ensure_column(c, 'users', 'has_reviewed', 'INTEGER DEFAULT 0')
        ensure_column(c, 'queues', 'created_at', 'TEXT')
        ensure_column(c, 'queues', 'archived', 'INTEGER DEFAULT 0')
        ensure_column(c, 'queues', 'order_type', 'TEXT')
        ensure_column(c, 'reviews', 'created_at', 'TEXT')

        # ข้อมูลเก่า: ใส่เวลา (เวลาไทย ณ ตอนย้ายระบบ) และชนิดออเดอร์
        c.execute("UPDATE queues SET created_at = ? WHERE created_at IS NULL OR created_at = ''", (now_str(),))
        c.execute("UPDATE reviews SET created_at = ? WHERE created_at IS NULL OR created_at = ''", (now_str(),))
        c.execute("UPDATE queues SET archived = 0 WHERE archived IS NULL")
        c.execute("""UPDATE queues SET order_type = CASE
                        WHEN service LIKE '%Press-On%' OR date LIKE '%สั่งเล็บปลอม%' THEN 'presson'
                        ELSE 'salon' END
                     WHERE order_type IS NULL OR order_type = ''""")

        # รหัสผ่านเดิม: บัญชีที่ระบบสร้างให้อัตโนมัติ (123456) ถูกล็อก ต้องสมัครใหม่ด้วยเบอร์เดิมเพื่อตั้งรหัส
        c.execute("UPDATE users SET password = '' WHERE password = '123456'")
        # รหัสผ่าน plaintext ที่เหลือ -> แฮช
        legacy = c.execute("""SELECT id, password FROM users
                              WHERE password IS NOT NULL AND password != ''
                                AND password NOT LIKE 'scrypt:%' AND password NOT LIKE 'pbkdf2:%'""").fetchall()
        for row in legacy:
            c.execute('UPDATE users SET password = ? WHERE id = ?',
                      (generate_password_hash(row['password']), row['id']))

        # ย้ายสลิป/รูปแบบเล็บเดิมออกจาก static/ (ซึ่งใครรู้ลิงก์ก็เปิดได้)
        for row in c.execute("SELECT id, slip_path, custom_img_path FROM queues").fetchall():
            new_slip = _move_legacy_file(row['slip_path'])
            new_custom = _move_legacy_file(row['custom_img_path'])
            if new_slip != row['slip_path'] or new_custom != row['custom_img_path']:
                c.execute('UPDATE queues SET slip_path = ?, custom_img_path = ? WHERE id = ?',
                          (new_slip, new_custom, row['id']))

        # path รูปสินค้า/รีวิวที่บันทึกจาก Windows (\\) -> /
        c.execute("UPDATE services SET image_path = REPLACE(image_path, char(92), '/') WHERE image_path LIKE '%' || char(92) || '%'")
        c.execute("UPDATE reviews SET image_path = REPLACE(image_path, char(92), '/') WHERE image_path LIKE '%' || char(92) || '%'")

        c.execute('CREATE INDEX IF NOT EXISTS idx_queues_phone ON queues(phone)')
        c.execute('CREATE INDEX IF NOT EXISTS idx_queues_status ON queues(status)')
        c.execute('CREATE INDEX IF NOT EXISTS idx_queues_date ON queues(date)')

        if c.execute('SELECT COUNT(*) AS n FROM services').fetchone()['n'] == 0:
            c.executemany(
                'INSERT INTO services (name, price, category, image_path, display_order) VALUES (?, ?, ?, ?, ?)', [
                    ('Press-On Set A', 350.0, 'custom', 'static/images/set_a.jpg', 1),
                    ('Press-On Set B', 500.0, 'custom', 'static/images/set_b.jpg', 2),
                    ('Press-On Set C', 1000.0, 'custom', 'static/images/set_c.jpg', 3),
                    ('Custom Press-On (ประเมินราคา)', 350.0, 'custom', 'static/images/custom_set.jpg', 4),
                    ('บริการต่อเล็บเจล + เพ้นท์ลาย', 200.0, 'booking', '', 1),
                    ('ถอดเล็บ + ทำบำรุง', 200.0, 'booking', '', 2),
                    ('บริการต่อเล็บเจล + ติดอะไหล่', 400.0, 'booking', '', 3),
                    ('ทาสีพื้น', 150.0, 'booking', '', 4),
                ])


# ---------------------------------------------------------------- สิทธิ์การเข้าถึง
def is_admin():
    return bool(session.get('admin')) and session.get('admin_exp', 0) > time.time()


def current_phone():
    return session.get('phone')


def admin_required(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        if not is_admin():
            return fail('ต้องเข้าสู่ระบบแอดมินก่อน', 401)
        return fn(*args, **kwargs)
    return wrapper


def customer_required(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        if not current_phone():
            return fail('กรุณาเข้าสู่ระบบก่อนทำรายการ', 401)
        return fn(*args, **kwargs)
    return wrapper


_attempts = {}


def too_many_attempts(key, limit=5, window=300):
    now = time.time()
    recent = [t for t in _attempts.get(key, []) if now - t < window]
    _attempts[key] = recent
    return len(recent) >= limit


def record_attempt(key):
    _attempts.setdefault(key, []).append(time.time())


def client_ip():
    return request.remote_addr or 'unknown'


@app.before_request
def check_origin():
    """กัน CSRF แบบง่าย: คำขอที่แก้ข้อมูลต้องมาจากโดเมนเดียวกัน"""
    if request.method in ('POST', 'PUT', 'PATCH', 'DELETE'):
        origin = request.headers.get('Origin')
        if origin and urlparse(origin).netloc != request.host:
            return fail('คำขอไม่ได้รับอนุญาต', 403)


@app.after_request
def add_headers(resp):
    resp.headers.setdefault('X-Content-Type-Options', 'nosniff')
    resp.headers.setdefault('X-Frame-Options', 'SAMEORIGIN')
    resp.headers.setdefault('Referrer-Policy', 'same-origin')
    if request.path.startswith('/api/'):
        resp.headers['Cache-Control'] = 'no-store'
    return resp


@app.errorhandler(413)
def too_large(_e):
    return fail('ไฟล์ใหญ่เกินไป (สูงสุด 8 MB)', 413)


@app.errorhandler(Exception)
def handle_exception(e):
    if isinstance(e, HTTPException):
        if request.path.startswith('/api/'):
            return fail(e.description or 'เกิดข้อผิดพลาด', e.code)
        return e
    app.logger.exception('Unhandled error')
    return fail('เกิดข้อผิดพลาดภายในเซิร์ฟเวอร์', 500)


# ---------------------------------------------------------------- อัปโหลดไฟล์
class UploadError(ValueError):
    pass


def _sniff_image(head):
    if head.startswith(b'\xff\xd8\xff'):
        return 'jpg'
    if head.startswith(b'\x89PNG\r\n\x1a\n'):
        return 'png'
    if head[:4] == b'RIFF' and head[8:12] == b'WEBP':
        return 'webp'
    if head[:6] in (b'GIF87a', b'GIF89a'):
        return 'gif'
    return None


def save_image(file_storage, folder, prefix):
    """ตรวจว่าเป็นรูปจริง (ดูจากเนื้อไฟล์) แล้วบันทึกด้วยชื่อสุ่ม คืนชื่อไฟล์"""
    head = file_storage.stream.read(16)
    file_storage.stream.seek(0)
    ext = _sniff_image(head)
    if not ext:
        raise UploadError('ไฟล์ต้องเป็นรูปภาพ JPG, PNG, WEBP หรือ GIF เท่านั้น')
    name = f'{prefix}_{secrets.token_hex(12)}.{ext}'
    os.makedirs(folder, exist_ok=True)
    file_storage.save(os.path.join(folder, name))
    return name


def remove_file(folder, name):
    try:
        os.remove(os.path.join(folder, name))
    except OSError:
        pass


def has_file(file_storage):
    return bool(file_storage and file_storage.filename)


# ---------------------------------------------------------------- ตัวช่วยแสดงผล
def _file_url(name):
    return f'files/{name}' if name else ''


def present_queue(row):
    """ข้อมูลเต็ม (ใช้กับเจ้าของออเดอร์หรือแอดมินเท่านั้น)"""
    d = dict(row)
    d['slip_path'] = _file_url(d.get('slip_path'))
    d['custom_img_path'] = _file_url(d.get('custom_img_path'))
    return d


def present_public_queue(row):
    """ข้อมูลสำหรับตารางคิวสาธารณะ: ไม่มีเบอร์ IG ที่อยู่ หรือสลิป"""
    return {
        'id': row['id'], 'name': mask_name(row['name']), 'fname': '', 'lname': '',
        'phone': '', 'ig_line': '', 'service': row['service'], 'date': row['date'],
        'time': row['time'], 'size': row['size'], 'status': row['status'],
        'slip_path': '', 'custom_img_path': '', 'address': '',
    }


def present_review(row):
    d = dict(row)
    d['phone'] = ''
    try:
        rating = int(d.get('rating') or 5)
    except (TypeError, ValueError):
        rating = 5
    d['rating'] = max(1, min(5, rating))
    return d


def user_public(u):
    return {'fname': u['fname'], 'lname': u['lname'], 'ig_line': u['ig_line'], 'phone': u['phone']}


# ---------------------------------------------------------------- หน้าเว็บ
@app.route('/')
def index():
    admin = is_admin()
    with db() as conn:
        services = [dict(r) for r in conn.execute(
            'SELECT * FROM services ORDER BY display_order ASC, id ASC')]
        confirmed = conn.execute(
            "SELECT * FROM queues WHERE status = 'confirmed' AND order_type = 'salon' AND archived = 0 "
            "ORDER BY id DESC").fetchall()
        reviews = [present_review(r) for r in conn.execute('SELECT * FROM reviews ORDER BY id DESC')]

        pending_salon_queues, delivery_queues, pending_customs, customers = [], [], [], []
        if admin:
            pending_salon_queues = [present_queue(r) for r in conn.execute(
                "SELECT * FROM queues WHERE status = 'pending_booking_approval' AND archived = 0 ORDER BY id DESC")]
            pending_customs = [present_queue(r) for r in conn.execute(
                "SELECT * FROM queues WHERE status = 'pending_approval' AND archived = 0 ORDER BY id DESC")]
            delivery_queues = [present_queue(r) for r in conn.execute(
                "SELECT * FROM queues WHERE order_type = 'presson' AND archived = 0 "
                "AND status IN ('confirmed', 'pending_presson_approval') ORDER BY id DESC")]
            customers = [dict(r) for r in conn.execute(
                'SELECT id, fname, lname, ig_line, phone, has_reviewed FROM users ORDER BY id DESC')]

    booking_queues = [present_queue(r) if admin else present_public_queue(r) for r in confirmed]

    return render_template(
        'index.html',
        services=services,
        press_on_services=[s for s in services if s['category'] == 'custom'],
        booking_services=[s for s in services if s['category'] == 'booking'],
        booking_queues=booking_queues,
        pending_salon_queues=pending_salon_queues,
        delivery_queues=delivery_queues,
        pending_customs=pending_customs,
        customers=customers,
        reviews=reviews,
        shop_province=SHOP_PROVINCE,
        is_admin=admin,
    )


@app.route('/api/config', methods=['GET'])
def get_config():
    today = now_th()
    return jsonify({
        'promptpay_id': PROMPTPAY_ID,
        'deposit': DEPOSIT_AMOUNT,
        'vat_rate': VAT_RATE,
        'free_shipping_threshold': FREE_SHIPPING_THRESHOLD,
        'shipping_in': SHIPPING_IN_PROVINCE,
        'shipping_out': SHIPPING_OUT_PROVINCE,
        'shop_province': SHOP_PROVINCE,
        'shop_address': SHOP_ADDRESS,
        'durations': SERVICE_DURATIONS,
        'closing_hour': CLOSING_HOUR,
        'today': today.strftime('%Y-%m-%d'),
        'max_date': (today + timedelta(days=MAX_BOOKING_DAYS_AHEAD)).strftime('%Y-%m-%d'),
        'now_hour': today.hour,
    })


@app.route('/api/me', methods=['GET'])
def me():
    if is_admin():
        return jsonify({'role': 'admin'})
    phone = current_phone()
    if phone:
        with db() as conn:
            u = conn.execute('SELECT * FROM users WHERE phone = ?', (phone,)).fetchone()
        if u:
            return jsonify({'role': 'customer', 'user': user_public(u)})
        session.pop('phone', None)
    return jsonify({'role': 'guest'})


# ---------------------------------------------------------------- สมาชิก
PHONE_RE = re.compile(r'^\d{9,10}$')


def _body():
    return request.get_json(silent=True) or request.form


@app.route('/api/register', methods=['POST'])
def register():
    data = _body()
    fname = (data.get('fname') or '').strip()[:60]
    lname = (data.get('lname') or '').strip()[:60]
    ig_line = (data.get('ig_line') or '').strip()[:60]
    phone = (data.get('phone') or '').strip()
    password = data.get('password') or ''

    if not (fname and lname and ig_line and phone and password):
        return fail('กรุณากรอกข้อมูลให้ครบถ้วน')
    if not PHONE_RE.match(phone):
        return fail('กรุณากรอกเบอร์โทรศัพท์เป็นตัวเลข 9-10 หลักให้ถูกต้อง')
    if len(password) < 6:
        return fail('รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร')
    if too_many_attempts('reg:' + client_ip(), limit=10, window=3600):
        return fail('ลองบ่อยเกินไป กรุณารอสักครู่', 429)
    record_attempt('reg:' + client_ip())

    with db() as conn:
        existing = conn.execute('SELECT id, password FROM users WHERE phone = ?', (phone,)).fetchone()
        if existing and existing['password']:
            return fail('เบอร์โทรศัพท์นี้ถูกลงทะเบียนแล้ว กรุณาเข้าสู่ระบบ')
        if existing:
            # บัญชีเก่าที่ระบบสร้างให้อัตโนมัติ (ยังไม่มีรหัสผ่าน) -> ตั้งรหัสผ่านใหม่
            conn.execute('UPDATE users SET fname=?, lname=?, ig_line=?, password=? WHERE id=?',
                         (fname, lname, ig_line, generate_password_hash(password), existing['id']))
        else:
            conn.execute('INSERT INTO users (fname, lname, ig_line, phone, password) VALUES (?, ?, ?, ?, ?)',
                         (fname, lname, ig_line, phone, generate_password_hash(password)))

    session.clear()
    session['phone'] = phone
    session.permanent = True
    return ok(message='สมัครสมาชิกสำเร็จ!',
              user={'fname': fname, 'lname': lname, 'ig_line': ig_line, 'phone': phone})


@app.route('/api/login', methods=['POST'])
def login():
    data = _body()
    phone = (data.get('phone') or '').strip()
    password = data.get('password') or ''

    if not phone or not password:
        return fail('กรุณากรอกเบอร์โทรและรหัสผ่าน')
    if not PHONE_RE.match(phone):
        return fail('กรุณากรอกเบอร์โทรศัพท์เป็นตัวเลข 9-10 หลัก')

    key = f'login:{client_ip()}:{phone}'
    if too_many_attempts(key):
        return fail('พยายามเข้าสู่ระบบหลายครั้งเกินไป กรุณารอ 5 นาที', 429)

    with db() as conn:
        user = conn.execute('SELECT * FROM users WHERE phone = ?', (phone,)).fetchone()

    if user and not user['password']:
        return fail('บัญชีนี้ยังไม่ได้ตั้งรหัสผ่าน กรุณาสมัครสมาชิกด้วยเบอร์เดิมเพื่อตั้งรหัสผ่าน')

    valid = False
    if user:
        try:
            valid = check_password_hash(user['password'], password)
        except ValueError:
            valid = False
    if not valid:
        record_attempt(key)
        return fail('เบอร์โทรศัพท์หรือรหัสผ่านไม่ถูกต้อง', 401)

    session.clear()
    session['phone'] = phone
    session.permanent = True
    return ok(message='เข้าสู่ระบบสำเร็จ!', user=user_public(user))


@app.route('/api/logout', methods=['POST'])
def logout():
    session.clear()
    return ok(message='ออกจากระบบแล้ว')


@app.route('/api/admin/login', methods=['POST'])
def admin_login():
    if not ADMIN_PASSWORD_HASH:
        return fail('ระบบยังไม่ได้ตั้งค่ารหัสผ่านแอดมิน (ตัวแปร ADMIN_PASSWORD)', 503)
    key = 'admin:' + client_ip()
    if too_many_attempts(key):
        return fail('พยายามเข้าสู่ระบบหลายครั้งเกินไป กรุณารอ 5 นาที', 429)
    password = (_body().get('password') or '')
    if not check_password_hash(ADMIN_PASSWORD_HASH, password):
        record_attempt(key)
        return fail('รหัสผ่านแอดมินไม่ถูกต้อง', 401)
    session.clear()
    session['admin'] = True
    session['admin_exp'] = time.time() + 8 * 3600
    return ok(message='เข้าสู่ระบบแอดมินเรียบร้อย')


# ---------------------------------------------------------------- คูปองและราคา
def validate_coupon(conn, phone, code):
    """คืน (ถูกต้องไหม, อัตราส่วนลด, ข้อความ)"""
    code = (code or '').strip().upper()
    if not code:
        return True, 0.0, ''
    placeholders = ','.join('?' * len(ACTIVE_STATUSES))

    if code == 'WELCOME10':
        count = conn.execute(
            f'SELECT COUNT(*) AS n FROM queues WHERE phone = ? AND status IN ({placeholders})',
            (phone, *ACTIVE_STATUSES)).fetchone()['n']
        if count:
            return False, 0.0, 'โค้ด WELCOME10 ใช้ได้เฉพาะออเดอร์แรกของลูกค้าใหม่เท่านั้น'
        return True, 0.10, 'ใช้โค้ด WELCOME10 สำเร็จ (รับส่วนลด 10%)'

    if code in REVIEW_CODES:
        user = conn.execute('SELECT has_reviewed FROM users WHERE phone = ?', (phone,)).fetchone()
        if not user or user['has_reviewed'] != 1:
            return False, 0.0, 'โค้ดนี้ใช้ได้เฉพาะลูกค้าที่เขียนรีวิวแล้วเท่านั้น'
        used = conn.execute(
            f"SELECT 1 FROM queues WHERE phone = ? AND coupon_code IN ('CORE APPLY','REVIEW5') "
            f"AND status IN ({placeholders})", (phone, *ACTIVE_STATUSES)).fetchone()
        if used:
            return False, 0.0, 'คุณเคยใช้โค้ดส่วนลดรีวิวไปแล้ว (จำกัด 1 ครั้งต่อบัญชี)'
        return True, 0.05, 'ใช้โค้ดส่วนลดรีวิวสำเร็จ (รับส่วนลด 5%)'

    return False, 0.0, 'โค้ดส่วนลดไม่ถูกต้องหรือหมดอายุ'


@app.route('/api/check_coupon', methods=['POST'])
@customer_required
def check_coupon():
    code = (_body().get('code') or '').strip().upper()
    if not code:
        return fail('กรุณากรอกโค้ดส่วนลด')
    with db() as conn:
        valid, rate, msg = validate_coupon(conn, current_phone(), code)
    if not valid:
        return fail(msg)
    return ok(message=msg, rate=rate)


def shipping_for(address, subtotal):
    if subtotal >= FREE_SHIPPING_THRESHOLD:
        return 0.0
    return SHIPPING_IN_PROVINCE if SHOP_PROVINCE in (address or '') else SHIPPING_OUT_PROVINCE


# ---------------------------------------------------------------- ลูกค้า: ดูข้อมูลตัวเอง
@app.route('/api/user/pending_payments', methods=['POST'])
def get_user_pending_payments():
    phone = current_phone()
    if not phone:
        return jsonify({'pending': [], 'orders': [], 'my_queues': []}), 200
    with db() as conn:
        def fetch(sql):
            return [present_queue(r) for r in conn.execute(sql, (phone,))]
        pending = fetch("SELECT * FROM queues WHERE phone = ? AND status = 'pending_payment' AND archived = 0 ORDER BY id DESC")
        orders = fetch("SELECT * FROM queues WHERE phone = ? AND order_type = 'presson' AND archived = 0 "
                       "AND status IN ('confirmed', 'pending_presson_approval') ORDER BY id DESC")
        my_queues = fetch("SELECT * FROM queues WHERE phone = ? AND order_type = 'salon' AND archived = 0 "
                          "AND status IN ('confirmed', 'pending_booking_approval') ORDER BY id DESC")
    return jsonify({'pending': pending, 'orders': orders, 'my_queues': my_queues}), 200


@app.route('/api/booked_slots', methods=['GET'])
def booked_slots():
    """คิวที่ถูกจองแล้ว (รวมที่รออนุมัติ) ใช้ปิดช่วงเวลาในฟอร์ม ไม่มีข้อมูลส่วนตัว"""
    date = request.args.get('date', '')
    if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', date):
        return jsonify({'slots': []})
    with db() as conn:
        rows = conn.execute(
            "SELECT time, service FROM queues WHERE date = ? AND order_type = 'salon' AND archived = 0 "
            "AND status IN ('confirmed', 'pending_booking_approval')", (date,)).fetchall()
    return jsonify({'slots': [{'time': r['time'], 'service': r['service']} for r in rows]})


# ---------------------------------------------------------------- ลูกค้า: สั่งซื้อ / จอง
def _get_user(conn, phone):
    return conn.execute('SELECT * FROM users WHERE phone = ?', (phone,)).fetchone()


def _build_salon_booking(conn, form):
    service_name = (form.get('service') or '').strip()
    date = (form.get('date') or '').strip()
    time_str = (form.get('time') or '').strip()

    svc = conn.execute("SELECT * FROM services WHERE name = ? AND category = 'booking'", (service_name,)).fetchone()
    if not svc:
        raise ValueError('ไม่พบบริการที่เลือก')

    try:
        book_date = datetime.strptime(date, '%Y-%m-%d').date()
    except ValueError:
        raise ValueError('รูปแบบวันที่ไม่ถูกต้อง')
    if not re.fullmatch(r'\d{2}:\d{2}', time_str):
        raise ValueError('รูปแบบเวลาไม่ถูกต้อง')

    now = now_th()
    if book_date < now.date():
        raise ValueError('ไม่สามารถจองวันที่ผ่านมาแล้ว')
    if book_date > now.date() + timedelta(days=MAX_BOOKING_DAYS_AHEAD):
        raise ValueError('จองล่วงหน้าได้ไม่เกิน 180 วัน')

    start = int(time_str[:2])
    end = start + (SERVICE_DURATIONS.get(service_name) or 1)
    if start < 0 or end > CLOSING_HOUR:
        raise ValueError('เวลาที่เลือกอยู่นอกเวลาทำการ')
    if book_date == now.date() and start <= now.hour:
        raise ValueError('เวลาที่เลือกผ่านไปแล้ว')

    existing = conn.execute(
        "SELECT time, service FROM queues WHERE date = ? AND order_type = 'salon' AND archived = 0 "
        "AND status IN ('confirmed', 'pending_booking_approval')", (date,)).fetchall()
    for row in existing:
        try:
            b_start = int(str(row['time'])[:2])
        except ValueError:
            continue
        b_end = b_start + (SERVICE_DURATIONS.get(row['service']) or 1)
        if max(start, b_start) < min(end, b_end):
            raise ValueError('ช่วงเวลานี้มีคิวจองแล้ว กรุณาเลือกเวลาอื่น')

    return {
        'order_type': 'salon', 'status': 'pending_booking_approval',
        'service': service_name, 'date': date, 'time': time_str, 'size': '-',
        'price': DEPOSIT_AMOUNT, 'shipping_fee': 0.0, 'discount': 0.0, 'vat': 0.0,
        'address': SHOP_ADDRESS, 'coupon_code': '',
    }


def _build_presson_cart(conn, form, phone):
    try:
        items = json.loads(form.get('items') or '[]')
    except ValueError:
        raise ValueError('ข้อมูลตะกร้าไม่ถูกต้อง')
    if not isinstance(items, list) or not items or len(items) > 20:
        raise ValueError('ตะกร้าสินค้าว่างหรือมีสินค้ามากเกินไป')

    address = (form.get('address') or '').strip()[:500]
    if not address:
        raise ValueError('กรุณากรอกที่อยู่จัดส่งสำหรับเล็บปลอม')

    names, sizes, subtotal = [], [], 0.0
    for it in items:
        name = str((it or {}).get('name', '')).strip()
        size = str((it or {}).get('size', '-')).strip()[:80] or '-'
        svc = conn.execute("SELECT * FROM services WHERE name = ? AND category = 'custom'", (name,)).fetchone()
        if not svc:
            raise ValueError(f'ไม่พบสินค้า: {name}')
        subtotal += float(svc['price'])
        names.append(svc['name'])
        sizes.append(f"{svc['name']}: {size}")

    coupon_code = (form.get('coupon_code') or '').strip().upper()
    valid, rate, msg = validate_coupon(conn, phone, coupon_code)
    if not valid:
        raise ValueError(msg)

    shipping = shipping_for(address, subtotal)
    vat = round2(subtotal * VAT_RATE)
    discount = round2(subtotal * rate)
    total = max(0.0, round2(subtotal + shipping + vat - discount))

    return {
        'order_type': 'presson', 'status': 'pending_presson_approval',
        'service': ', '.join(names), 'date': 'สั่งเล็บปลอม (Press-On)', 'time': '-',
        'size': ' | '.join(sizes), 'price': total, 'shipping_fee': shipping,
        'discount': discount, 'vat': vat, 'address': address,
        'coupon_code': coupon_code if rate else '',
    }


@app.route('/api/order', methods=['POST'])
@customer_required
def create_order():
    phone = current_phone()
    form = request.form
    slip_file = request.files.get('slip')
    if not has_file(slip_file):
        return fail('กรุณาแนบไฟล์สลิปชำระเงิน')

    saved_name = None
    conn = sqlite3.connect(DB_NAME, timeout=10)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute('BEGIN IMMEDIATE')   # ล็อกเขียนไว้ตลอดการตรวจ เพื่อกันจองชนและใช้คูปองซ้ำ
        user = _get_user(conn, phone)
        if not user:
            conn.rollback()
            return fail('ไม่พบบัญชีผู้ใช้ กรุณาเข้าสู่ระบบใหม่', 401)

        queue_id = (form.get('queue_id') or '').strip()
        try:
            if queue_id:
                # ชำระเงินออเดอร์ Custom ที่แอดมินประเมินราคาแล้ว: ใช้ราคาจากฐานข้อมูลเท่านั้น
                row = conn.execute(
                    "SELECT * FROM queues WHERE id = ? AND phone = ? AND status = 'pending_payment' AND archived = 0",
                    (queue_id, phone)).fetchone()
                if not row:
                    conn.rollback()
                    return fail('ไม่พบรายการที่รอชำระเงิน', 404)
                item_price = float(row['price'] or 0)
                shipping = float(row['shipping_fee'] or 0)
                vat = round2(item_price * VAT_RATE)
                total = round2(item_price + shipping + vat)
                saved_name = save_image(slip_file, PRIVATE_UPLOAD_DIR, 'slip')
                cur = conn.execute(
                    "UPDATE queues SET status='pending_presson_approval', slip_path=?, vat=?, discount=0, "
                    "price=?, delivery_status='กำลังเตรียมจัดส่ง', coupon_code='' "
                    "WHERE id = ? AND status = 'pending_payment'",
                    (saved_name, vat, total, row['id']))
                if cur.rowcount != 1:
                    raise ValueError('รายการนี้ถูกชำระเงินไปแล้ว')
                new_id = row['id']
            else:
                if form.get('items'):
                    data = _build_presson_cart(conn, form, phone)
                else:
                    data = _build_salon_booking(conn, form)

                if data['order_type'] == 'presson':
                    dup = conn.execute(
                        "SELECT 1 FROM queues WHERE phone = ? AND status = 'pending_presson_approval' "
                        "AND service = ? AND size = ? AND price = ? AND created_at >= ?",
                        (phone, data['service'], data['size'], data['price'],
                         (now_th() - timedelta(seconds=60)).strftime(TS_FORMAT))).fetchone()
                    if dup:
                        raise ValueError('ระบบได้รับออเดอร์นี้แล้ว กรุณาอย่ากดซ้ำ')

                saved_name = save_image(slip_file, PRIVATE_UPLOAD_DIR, 'slip')
                full_name = f"{user['fname']} {user['lname']}".strip()
                cur = conn.execute(
                    """INSERT INTO queues (name, fname, lname, ig_line, phone, service, date, time, size,
                                           slip_path, status, price, address, shipping_fee, discount, vat,
                                           delivery_status, coupon_code, created_at, archived, order_type)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'กำลังเตรียมจัดส่ง', ?, ?, 0, ?)""",
                    (full_name, user['fname'], user['lname'], user['ig_line'], phone,
                     data['service'], data['date'], data['time'], data['size'], saved_name,
                     data['status'], data['price'], data['address'], data['shipping_fee'],
                     data['discount'], data['vat'], data['coupon_code'], now_str(), data['order_type']))
                new_id = cur.lastrowid
        except (ValueError, UploadError) as exc:
            conn.rollback()
            if saved_name:
                remove_file(PRIVATE_UPLOAD_DIR, saved_name)
            return fail(str(exc))

        conn.commit()
        row = conn.execute('SELECT * FROM queues WHERE id = ?', (new_id,)).fetchone()
        queue = present_queue(row)
    except Exception:
        conn.rollback()
        if saved_name:
            remove_file(PRIVATE_UPLOAD_DIR, saved_name)
        raise
    finally:
        conn.close()

    return ok(message='ส่งสลิปชำระเงินเรียบร้อยแล้ว! แอดมินกำลังตรวจสอบสลิป เมื่ออนุมัติแล้วรายการจะได้รับการดำเนินการ',
              queue=queue)


@app.route('/api/custom_estimate', methods=['POST'])
@customer_required
def create_custom_estimate():
    phone = current_phone()
    size = (request.form.get('size') or '').strip()[:80]
    address = (request.form.get('address') or '').strip()[:500]
    custom_img = request.files.get('custom_img')

    if not size or not address:
        return fail('กรุณากรอกข้อมูลให้ครบถ้วน')
    if not has_file(custom_img):
        return fail('กรุณาอัปโหลดรูปภาพแบบเล็บ')

    with db() as conn:
        user = _get_user(conn, phone)
        if not user:
            return fail('ไม่พบบัญชีผู้ใช้ กรุณาเข้าสู่ระบบใหม่', 401)
        waiting = conn.execute(
            "SELECT COUNT(*) AS n FROM queues WHERE phone = ? AND status = 'pending_approval' AND archived = 0",
            (phone,)).fetchone()['n']
        if waiting >= 3:
            return fail('คุณมีรายการรอประเมินราคาอยู่แล้ว กรุณารอแอดมินตอบกลับก่อน')

        try:
            saved = save_image(custom_img, PRIVATE_UPLOAD_DIR, 'custom')
        except UploadError as exc:
            return fail(str(exc))

        full_name = f"{user['fname']} {user['lname']}".strip()
        cur = conn.execute(
            """INSERT INTO queues (name, fname, lname, ig_line, phone, service, date, time, size,
                                   custom_img_path, status, price, shipping_fee, address, created_at,
                                   archived, order_type)
               VALUES (?, ?, ?, ?, ?, ?, ?, '-', ?, ?, 'pending_approval', ?, ?, ?, ?, 0, 'presson')""",
            (full_name, user['fname'], user['lname'], user['ig_line'], phone,
             'Custom Press-On (ประเมินราคา)', 'สั่งเล็บปลอม (Custom)', size, saved,
             CUSTOM_PLACEHOLDER_PRICE, SHIPPING_IN_PROVINCE, address, now_str()))
        new_id = cur.lastrowid

    return ok(message='ส่งรูปให้แอดมินประเมินราคาเรียบร้อยแล้ว เมื่ออนุมัติแล้วยอดจะแสดงในตะกร้า', id=new_id)


@app.route('/api/review/add', methods=['POST'])
@customer_required
def add_review():
    phone = current_phone()
    comment = (request.form.get('comment') or '').strip()[:1000]
    review_img = request.files.get('image')
    try:
        rating = int(request.form.get('rating', 5))
    except ValueError:
        return fail('คะแนนไม่ถูกต้อง')
    if not 1 <= rating <= 5:
        return fail('คะแนนต้องอยู่ระหว่าง 1-5')
    if not comment:
        return fail('กรุณากรอกคำรีวิว')

    with db() as conn:
        user = _get_user(conn, phone)
        if not user:
            return fail('ไม่พบบัญชีผู้ใช้ กรุณาเข้าสู่ระบบใหม่', 401)
        if user['has_reviewed']:
            return fail('บัญชีนี้รีวิวไปแล้ว (จำกัด 1 ครั้งต่อบัญชี)')
        bought = conn.execute("SELECT 1 FROM queues WHERE phone = ? AND status = 'confirmed' LIMIT 1", (phone,)).fetchone()
        if not bought:
            return fail('รีวิวได้เฉพาะลูกค้าที่มีออเดอร์ที่ได้รับการยืนยันแล้ว')

        image_path = ''
        if has_file(review_img):
            try:
                image_path = f"{PUBLIC_UPLOAD_URL}/{save_image(review_img, PUBLIC_UPLOAD_DIR, 'rev')}"
            except UploadError as exc:
                return fail(str(exc))

        name = f"{user['fname']} {user['lname']}".strip()
        conn.execute('INSERT INTO reviews (phone, name, rating, comment, image_path, created_at) VALUES (?, ?, ?, ?, ?, ?)',
                     (phone, name, rating, comment, image_path, now_str()))
        conn.execute('UPDATE users SET has_reviewed = 1 WHERE phone = ?', (phone,))

    return ok(message='ขอบคุณสำหรับรีวิว! คุณได้รับส่วนลด 5% (ใช้โค้ด REVIEW5 หรือ CORE APPLY)')


# ---------------------------------------------------------------- ไฟล์ส่วนตัว (สลิป/รูปแบบเล็บ)
@app.route('/files/<path:filename>')
def private_file(filename):
    filename = os.path.basename(filename)
    if not re.fullmatch(r'[A-Za-z0-9_.\-]+', filename):
        abort(404)
    if not is_admin():
        phone = current_phone()
        if not phone:
            abort(404)
        with db() as conn:
            owner = conn.execute('SELECT 1 FROM queues WHERE phone = ? AND (slip_path = ? OR custom_img_path = ?)',
                                 (phone, filename, filename)).fetchone()
        if not owner:
            abort(404)
    resp = send_from_directory(PRIVATE_UPLOAD_DIR, filename)
    resp.headers['Cache-Control'] = 'private, no-store'
    return resp


# ---------------------------------------------------------------- แอดมิน
SALES_PERIOD_RE = re.compile(r'^\d{4}-(0[1-9]|1[0-2])$')
MAX_SALES_AMOUNT = 100_000_000


@app.route('/api/admin/sales_report', methods=['GET'])
@admin_required
def get_sales_report():
    now = now_th()
    try:
        year = int(request.args.get('year', now.year))
    except ValueError:
        year = now.year
    if not 2000 <= year <= 2100:
        year = now.year

    with db() as conn:
        def total(since):
            row = conn.execute(
                "SELECT COALESCE(SUM(price), 0) AS s FROM queues WHERE status = 'confirmed' AND created_at >= ?",
                (since.strftime(TS_FORMAT),)).fetchone()
            return round2(row['s'])
        today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
        sales = {
            'daily': total(today_start),
            'weekly': total(now - timedelta(days=7)),
            'monthly': total(now - timedelta(days=30)),
            'yearly': total(now - timedelta(days=365)),
        }

        # ยอดรายเดือนของปีที่เลือก: ยอดจากออเดอร์จริง + ยอดที่แอดมินแก้ไข (ถ้ามี)
        auto = {r['p']: round2(r['s']) for r in conn.execute(
            "SELECT substr(created_at, 1, 7) AS p, COALESCE(SUM(price), 0) AS s FROM queues "
            "WHERE status = 'confirmed' AND substr(created_at, 1, 4) = ? GROUP BY p", (str(year),))}
        adjusted = {r['period']: r for r in conn.execute(
            'SELECT period, amount, updated_at FROM sales_adjustments WHERE period LIKE ?', (f'{year}-%',))}

    months = []
    for m in range(1, 13):
        period = f'{year}-{m:02d}'
        adj = adjusted.get(period)
        auto_amount = auto.get(period, 0.0)
        months.append({
            'period': period,
            'month': m,
            'auto': auto_amount,
            'adjusted': round2(adj['amount']) if adj else None,
            'effective': round2(adj['amount']) if adj else auto_amount,
            'updated_at': adj['updated_at'] if adj else None,
        })
    return ok(sales=sales, year=year, current_period=now.strftime('%Y-%m'), months=months)


@app.route('/api/admin/sales_adjust', methods=['POST'])
@admin_required
def adjust_sales():
    """แก้ไขยอดขายรายเดือน (บันทึกเวลาที่แก้ไข) หรือล้างยอดที่แก้ไขเพื่อกลับไปใช้ยอดจากระบบ"""
    data = _body()
    period = (data.get('period') or '').strip()
    if not SALES_PERIOD_RE.match(period):
        return fail('รูปแบบเดือนไม่ถูกต้อง')

    raw = data.get('amount')
    if raw is None or str(raw).strip() == '':
        with db() as conn:
            conn.execute('DELETE FROM sales_adjustments WHERE period = ?', (period,))
        return ok(message='ล้างยอดที่แก้ไขแล้ว กลับไปใช้ยอดจากระบบ')

    try:
        amount = float(raw)
    except (TypeError, ValueError):
        return fail('กรุณากรอกยอดขายเป็นตัวเลข')
    if not math.isfinite(amount) or amount < 0 or amount > MAX_SALES_AMOUNT:
        return fail('ยอดขายต้องอยู่ระหว่าง 0 - 100,000,000 บาท')

    stamp = now_str()
    with db() as conn:
        conn.execute(
            'INSERT INTO sales_adjustments (period, amount, updated_at) VALUES (?, ?, ?) '
            'ON CONFLICT(period) DO UPDATE SET amount = excluded.amount, updated_at = excluded.updated_at',
            (period, round2(amount), stamp))
    return ok(message='บันทึกยอดขายที่แก้ไขเรียบร้อยแล้ว', updated_at=stamp)


@app.route('/api/admin/pending_salon_queues', methods=['GET'])
@admin_required
def get_pending_salon_queues():
    with db() as conn:
        rows = conn.execute("SELECT * FROM queues WHERE status = 'pending_booking_approval' AND archived = 0 "
                            "ORDER BY id DESC").fetchall()
    return ok(pending_salon_queues=[present_queue(r) for r in rows])


def _parse_price(value):
    try:
        price = float(value)
    except (TypeError, ValueError):
        return None
    return price if price > 0 else None


def _save_service_image(file_storage):
    return f"{PUBLIC_UPLOAD_URL}/{save_image(file_storage, PUBLIC_UPLOAD_DIR, 'svc')}"


@app.route('/api/admin/add_service', methods=['POST'])
@admin_required
def add_service():
    name = (request.form.get('name') or '').strip()[:120]
    price = _parse_price(request.form.get('price'))
    category = (request.form.get('category') or 'custom').strip()
    img_file = request.files.get('image')

    if not name or price is None or category not in SERVICE_CATEGORIES:
        return fail('กรุณากรอกชื่อและราคาให้ถูกต้อง')
    try:
        image_path = _save_service_image(img_file) if has_file(img_file) else ''
    except UploadError as exc:
        return fail(str(exc))

    with db() as conn:
        max_order = conn.execute('SELECT MAX(display_order) AS m FROM services WHERE category = ?', (category,)).fetchone()['m']
        conn.execute('INSERT INTO services (name, price, category, image_path, display_order) VALUES (?, ?, ?, ?, ?)',
                     (name, price, category, image_path, (max_order or 0) + 1))
    return ok(message='เพิ่มรายการเรียบร้อยแล้ว')


@app.route('/api/admin/edit_service', methods=['POST'])
@admin_required
def edit_service():
    service_id = request.form.get('service_id')
    name = (request.form.get('name') or '').strip()[:120]
    price = _parse_price(request.form.get('price'))
    category = (request.form.get('category') or 'custom').strip()
    img_file = request.files.get('image')

    if not service_id or not name or price is None or category not in SERVICE_CATEGORIES:
        return fail('ข้อมูลไม่ถูกต้อง')
    try:
        image_path = _save_service_image(img_file) if has_file(img_file) else None
    except UploadError as exc:
        return fail(str(exc))

    with db() as conn:
        if image_path:
            conn.execute('UPDATE services SET name=?, price=?, category=?, image_path=? WHERE id=?',
                         (name, price, category, image_path, service_id))
        else:
            conn.execute('UPDATE services SET name=?, price=?, category=? WHERE id=?',
                         (name, price, category, service_id))
    return ok(message='แก้ไขข้อมูลเรียบร้อยแล้ว')


@app.route('/api/admin/delete_service/<int:service_id>', methods=['POST', 'DELETE'])
@admin_required
def delete_service(service_id):
    with db() as conn:
        conn.execute('DELETE FROM services WHERE id = ?', (service_id,))
    return ok(message=f'ลบรายการ ID #{service_id} เรียบร้อยแล้ว')


def _transition(queue_id, from_status, to_status, success_message, not_found_message):
    with db() as conn:
        cur = conn.execute('UPDATE queues SET status = ? WHERE id = ? AND status = ? AND archived = 0',
                           (to_status, queue_id, from_status))
        if cur.rowcount != 1:
            return fail(not_found_message, 404)
        row = conn.execute('SELECT * FROM queues WHERE id = ?', (queue_id,)).fetchone()
    return ok(message=success_message, queue=present_queue(row))


@app.route('/api/admin/approve_salon_booking', methods=['POST'])
@admin_required
def approve_salon_booking():
    queue_id = _body().get('queue_id')
    return _transition(queue_id, 'pending_booking_approval', 'confirmed',
                       'อนุมัติคิวจองทำเล็บเรียบร้อยแล้ว', 'ไม่พบคิวที่รออนุมัติ (อาจถูกอนุมัติหรือปฏิเสธไปแล้ว)')


@app.route('/api/admin/approve_presson_order', methods=['POST'])
@admin_required
def approve_presson_order():
    queue_id = _body().get('queue_id')
    return _transition(queue_id, 'pending_presson_approval', 'confirmed',
                       'อนุมัติสลิปสั่งซื้อสินค้าเรียบร้อยแล้ว พร้อมดำเนินการจัดส่ง',
                       'ไม่พบรายการที่รออนุมัติ (อาจถูกอนุมัติหรือปฏิเสธไปแล้ว)')


@app.route('/api/admin/reject_order', methods=['POST'])
@admin_required
def reject_order():
    queue_id = _body().get('queue_id')
    with db() as conn:
        cur = conn.execute(
            "UPDATE queues SET status = 'rejected' WHERE id = ? AND archived = 0 "
            "AND status IN ('pending_booking_approval', 'pending_presson_approval')", (queue_id,))
        if cur.rowcount != 1:
            return fail('ไม่พบรายการที่รออนุมัติ', 404)
    return ok(message='ปฏิเสธรายการเรียบร้อยแล้ว (ช่วงเวลาที่จองจะถูกปล่อยว่าง)')


@app.route('/api/owner/approve_custom', methods=['POST'])
@admin_required
def approve_custom():
    data = _body()
    queue_id = data.get('queue_id')
    price = _parse_price(data.get('price'))
    try:
        shipping = float(data.get('shipping_fee', SHIPPING_IN_PROVINCE))
    except (TypeError, ValueError):
        shipping = -1
    if not queue_id or price is None or shipping < 0:
        return fail('ข้อมูลไม่ถูกต้อง')

    with db() as conn:
        cur = conn.execute("UPDATE queues SET price = ?, shipping_fee = ?, status = 'pending_payment' "
                           "WHERE id = ? AND status = 'pending_approval' AND archived = 0", (price, shipping, queue_id))
        if cur.rowcount != 1:
            return fail('ไม่พบคิวที่รอประเมินราคา', 404)
        row = conn.execute('SELECT * FROM queues WHERE id = ?', (queue_id,)).fetchone()
    return ok(message='อนุมัติราคาเรียบร้อยแล้ว รายการจะไปแสดงในตะกร้าของลูกค้า', queue=present_queue(row))


@app.route('/api/owner/update_delivery', methods=['POST'])
@admin_required
def update_delivery():
    data = _body()
    queue_id = data.get('queue_id')
    status = (data.get('delivery_status') or DELIVERY_STATUSES[0]).strip()
    tracking = (data.get('tracking_number') or '-').strip()[:60] or '-'

    if not queue_id:
        return fail('ระบุคิวที่ต้องการอัปเดต')
    if status not in DELIVERY_STATUSES:
        return fail('สถานะจัดส่งไม่ถูกต้อง')

    with db() as conn:
        cur = conn.execute("UPDATE queues SET delivery_status = ?, tracking_number = ? "
                           "WHERE id = ? AND status = 'confirmed'", (status, tracking, queue_id))
        if cur.rowcount != 1:
            return fail('อัปเดตได้เฉพาะออเดอร์ที่อนุมัติแล้ว', 404)
    return ok(message='อัปเดตสถานะจัดส่งเรียบร้อยแล้ว')


@app.route('/api/queue/delete/<int:queue_id>', methods=['DELETE', 'POST'])
@admin_required
def delete_queue(queue_id):
    """ซ่อนรายการ (archive) ไม่ลบจริง เพื่อให้ยอดขายย้อนหลังยังอยู่"""
    with db() as conn:
        conn.execute('UPDATE queues SET archived = 1 WHERE id = ?', (queue_id,))
    return ok(message=f'ลบรายการ ID #{queue_id} เรียบร้อยแล้ว (ยอดขายยังคงถูกเก็บไว้)')


@app.route('/api/queue/clear_all', methods=['POST'])
@admin_required
def clear_all_queues():
    with db() as conn:
        conn.execute('UPDATE queues SET archived = 1 WHERE archived = 0')
    return ok(message='ล้างรายการคิวทั้งหมดเรียบร้อยแล้ว (ยอดขายยังคงถูกเก็บไว้)')


@app.route('/api/customer/delete/<int:user_id>', methods=['DELETE', 'POST'])
@admin_required
def delete_customer(user_id):
    with db() as conn:
        conn.execute('DELETE FROM users WHERE id = ?', (user_id,))
    return ok(message=f'ลบลูกค้า ID #{user_id} เรียบร้อยแล้ว')


# ---------------------------------------------------------------- เริ่มระบบ
init_db()

if __name__ == '__main__':
    app.run(host='127.0.0.1', port=5001, debug=os.environ.get('FLASK_DEBUG') == '1')