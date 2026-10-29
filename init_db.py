import sqlite3

connection = sqlite3.connect('database.db')
cursor = connection.cursor()

cursor.execute('''
CREATE TABLE IF NOT EXISTS services (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, category TEXT, price REAL
)''')

cursor.execute('''
CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT, customer_name TEXT, phone TEXT, 
    service_name TEXT, book_date TEXT, book_time TEXT, total_price REAL, qr_code_path TEXT
)''')

services = [
    ('ทาสีเจลมือ (ไม่จำกัดสี)', 'booking', 250.00),
    ('ต่อเล็บ PVC + ทาสีเจล', 'booking', 450.00),
    ('เล็บปลอมสำเร็จรูป ลายลูกแก้ว', 'product', 150.00),
    ('เล็บปลอมสำเร็จรูป ลายเพ้นท์มินิมอล', 'product', 120.00)
]
cursor.executemany("INSERT INTO services (name, category, price) VALUES (?, ?, ?)", services)

connection.commit()
connection.close()
print("สร้างฐานข้อมูล database.db สำเร็จ!")