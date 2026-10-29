let currentLang = 'th';
let currentUserRole = 'guest';
let isQueueExpanded = false;

// ค่าตั้งต้น (สำรอง) ค่าจริงถูกโหลดจากเซิร์ฟเวอร์ผ่าน /api/config ตอนเปิดหน้าเว็บ
// ใช้เพื่อแสดงผลเท่านั้น ราคาและส่วนลดจริงคำนวณที่เซิร์ฟเวอร์ทุกครั้ง
const CONFIG = {
    promptpay_id: '0946486003',
    deposit: 100,
    vat_rate: 0.07,
    free_shipping_threshold: 1500,
    shipping_in: 50,
    shipping_out: 100,
    shop_province: 'ขอนแก่น',
    durations: {},
    closing_hour: 21,
    today: '',
    max_date: '',
    now_hour: 0
};

function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
}

function fileUrl(path) {
    return path ? '/' + String(path).split('/').map(encodeURIComponent).join('/') : '';
}

function round2(value) {
    return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

async function loadConfig() {
    try {
        const res = await fetch('/api/config');
        if (res.ok) Object.assign(CONFIG, await res.json());
    } catch (e) {
        console.error('Config load error:', e);
    }
}

function setupBookingDateMin() {
    const dateInput = document.getElementById('book_date');
    if (dateInput && CONFIG.today) {
        dateInput.min = CONFIG.today;
        if (CONFIG.max_date) dateInput.max = CONFIG.max_date;
    }
}

let cart = [];
let pendingCartItem = null;
let currentPendingOrderData = null;
let pendingPaymentsList = [];
let customerOrdersList = [];
let mySalonQueuesList = [];

let autoDetectedShippingFee = 50;
let currentDiscountAmount = 0;
let appliedCouponCode = '';
let appliedCouponRate = 0;
let currentUser = null;
let isSubmittingOrder = false;

const tablePaginationState = {
    'pendingSalonTableBody': { page: 1, pageSize: 5 },
    'deliveryTableBody': { page: 1, pageSize: 5 },
    'pendingCustomTableBody': { page: 1, pageSize: 5 },
    'customerTableBody': { page: 1, pageSize: 5 }
};

function getCartStorageKey(phoneNum = null) {
    const phone = phoneNum || (currentUser && currentUser.phone);
    return phone ? `25nail_cart_${phone}` : '25nail_cart_guest';
}

function saveCartToStorage() {
    try {
        const key = getCartStorageKey();
        localStorage.setItem(key, JSON.stringify(cart));
    } catch (e) {
        console.error('Save cart error:', e);
    }
}

function loadCartFromStorage(phoneNum = null) {
    try {
        const key = getCartStorageKey(phoneNum);
        const savedCart = localStorage.getItem(key);
        if (savedCart) {
            cart = JSON.parse(savedCart);
        } else {
            cart = [];
        }
    } catch (e) {
        cart = [];
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    // ล้างค่าเก่าที่เคยเก็บบทบาท/ข้อมูลผู้ใช้ไว้ในเบราว์เซอร์ (ตอนนี้ใช้เซสชันฝั่งเซิร์ฟเวอร์แทน)
    localStorage.removeItem('25nail_role');
    localStorage.removeItem('25nail_user');

    await loadConfig();
    setupBookingDateMin();
    await loadUserSession();
    applyQueueMasking();
    updateQueueVisibility();
    updateCartUI();
    injectRejectButtons();

    window.addEventListener('click', function(event) {
        if (event.target && event.target.classList && event.target.classList.contains('modal-overlay')) {
            event.target.style.display = 'none';
        }
    });
});

function safeSetText(id, text) {
    const el = document.getElementById(id);
    if (el) el.innerText = text;
}

function safeSetValue(id, val) {
    const el = document.getElementById(id);
    if (el) el.value = val;
}

function requireCustomerAuth() {
    if (currentUserRole !== 'customer') {
        alert(currentLang === 'th' ? 'กรุณาเข้าสู่ระบบหรือสมัครสมาชิกก่อนทำรายการครับ' : 'Please login or register first');
        openCustomerLoginModal();
        return false;
    }
    return true;
}

function saveUserSession(role, user = null) {
    currentUser = user;
}

async function loadUserSession() {
    let me = { role: 'guest' };
    try {
        const res = await fetch('/api/me');
        me = await res.json();
    } catch (e) {
        console.error('Session load error', e);
    }

    if (me.role === 'admin') {
        currentUserRole = 'admin';
        refreshAuthLabels();
        const logoutElem = document.getElementById('logout-btn');
        if (logoutElem) logoutElem.style.display = 'inline-block';
        fetchSalesReport();
    } else if (me.role === 'customer' && me.user) {
        const user = me.user;
        currentUserRole = 'customer';
        currentUser = user;
        refreshAuthLabels();
        const logoutElem = document.getElementById('logout-btn');
        if (logoutElem) logoutElem.style.display = 'inline-block';

        safeSetValue('cust_fname', user.fname);
        safeSetValue('cust_lname', user.lname);
        safeSetValue('cust_ig_line', user.ig_line);
        safeSetValue('cust_phone', user.phone);
        safeSetValue('cart_search_phone', user.phone);
        safeSetValue('track_search_phone', user.phone);
        safeSetValue('rev_name', `${user.fname} ${user.lname}`);
        safeSetValue('rev_phone', user.phone);

        loadCartFromStorage(user.phone);
        fetchUserPendingPayments();
    } else {
        currentUserRole = 'guest';
        loadCartFromStorage(null);
    }
}

function handleLogout() {
    if (!confirm(currentLang === 'th' ? 'คุณต้องการออกจากระบบใช่หรือไม่?' : 'Are you sure you want to logout?')) return;
    saveCartToStorage();
    fetch('/api/logout', { method: 'POST' })
        .catch(err => console.error(err))
        .finally(() => location.reload());
}

// สรุปยอดขาย
let salesYear = null;
let salesData = null;
const MONTHS_TH = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function fetchSalesReport(year) {
    if (year) salesYear = year;
    const qs = salesYear ? `?year=${salesYear}` : '';
    fetch('/api/admin/sales_report' + qs)
    .then(res => res.json())
    .then(data => {
        if (data.status === 'success' && data.sales) {
            safeSetText('sales-daily', `${data.sales.daily.toLocaleString()} ฿`);
            safeSetText('sales-weekly', `${data.sales.weekly.toLocaleString()} ฿`);
            safeSetText('sales-monthly', `${data.sales.monthly.toLocaleString()} ฿`);
            safeSetText('sales-yearly', `${data.sales.yearly.toLocaleString()} ฿`);
            salesYear = data.year;
            salesData = data;
            renderSalesEditor();
        }
    })
    .catch(err => console.error('Sales report error:', err));
}

function changeSalesYear(delta) {
    if (!salesYear) return;
    fetchSalesReport(salesYear + delta);
}

// "2026-10-29 14:05:00" (เวลาไทย) -> ข้อความวันเวลาตามภาษาที่เลือก
function formatSalesStamp(stamp) {
    if (!stamp) return '-';
    const d = new Date(stamp.replace(' ', 'T') + '+07:00');
    if (isNaN(d.getTime())) return stamp;
    return d.toLocaleString(currentLang === 'th' ? 'th-TH' : 'en-GB', {
        timeZone: 'Asia/Bangkok', day: 'numeric', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit'
    });
}

function renderSalesEditor() {
    const body = document.getElementById('salesMonthTableBody');
    const chart = document.getElementById('sales-chart');
    if (!body || !chart || !salesData) return;

    const th = currentLang === 'th';
    const months = th ? MONTHS_TH : MONTHS_EN;
    safeSetText('sales-year-label', th ? `ปี ${salesData.year + 543}` : `${salesData.year}`);

    const max = Math.max(...salesData.months.map(m => m.effective), 0);
    let chartHtml = '';
    let rowsHtml = '';
    let totalAuto = 0;
    let totalEffective = 0;

    salesData.months.forEach(m => {
        totalAuto += m.auto;
        totalEffective += m.effective;
        const edited = m.adjusted !== null;
        const isNow = m.period === salesData.current_period;
        const barPx = max > 0 ? Math.max(2, Math.round((m.effective / max) * 130)) : 2;
        const label = months[m.month - 1];

        chartHtml += `<div class="sales-bar-col${isNow ? ' now' : ''}" title="${label}: ${m.effective.toLocaleString()} ฿">
            <div class="sales-bar-area">
                <span class="sales-bar-val">${m.effective > 0 ? m.effective.toLocaleString() : ''}</span>
                <div class="sales-bar${edited ? ' edited' : ''}" style="height:${barPx}px"></div>
            </div>
            <span class="sales-bar-label">${label}</span>
        </div>`;

        rowsHtml += `<tr id="sales-row-${m.period}">
            <td><strong>${label}</strong></td>
            <td>${m.auto.toLocaleString()} ฿</td>
            <td><input type="number" min="0" step="0.01" class="pill-input sales-input" id="sales-input-${m.period}"
                       value="${edited ? m.adjusted : ''}" placeholder="${m.auto}"
                       onkeydown="if(event.key==='Enter'){saveSalesAdjust('${m.period}')}"></td>
            <td class="sales-stamp">${edited ? formatSalesStamp(m.updated_at) : '-'}</td>
            <td>
                <button class="pill-btn sales-save-btn" onclick="saveSalesAdjust('${m.period}')">${th ? 'บันทึก' : 'Save'}</button>
                ${edited ? `<button class="delete-btn" onclick="resetSalesAdjust('${m.period}')">${th ? 'ล้าง' : 'Reset'}</button>` : ''}
            </td>
        </tr>`;
    });

    chart.innerHTML = chartHtml;
    body.innerHTML = rowsHtml;
    safeSetText('sales-total-auto', `${totalAuto.toLocaleString()} ฿`);
    safeSetText('sales-total-effective', (th ? 'หลังแก้ไข: ' : 'After edits: ') + `${totalEffective.toLocaleString()} ฿`);
}

function saveSalesAdjust(period) {
    const input = document.getElementById(`sales-input-${period}`);
    const value = input ? input.value.trim() : '';
    if (value === '') {
        alert(currentLang === 'th' ? 'กรุณากรอกยอดขายที่ต้องการแก้ไข (หรือกด "ล้าง" เพื่อกลับไปใช้ยอดจากระบบ)' : 'Please enter an amount (or press Reset to use the system total)');
        return;
    }
    postSalesAdjust(period, value);
}

function resetSalesAdjust(period) {
    if (!confirm(currentLang === 'th' ? 'ล้างยอดที่แก้ไข และกลับไปใช้ยอดจากระบบใช่หรือไม่?' : 'Reset to the system total?')) return;
    postSalesAdjust(period, '');
}

function postSalesAdjust(period, amount) {
    fetch('/api/admin/sales_adjust', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ period: period, amount: amount })
    })
    .then(res => res.json())
    .then(data => {
        if (data.status === 'success') {
            fetchSalesReport();
        } else {
            alert('เกิดข้อผิดพลาด: ' + data.message);
        }
    })
    .catch(err => console.error(err));
}

function filterSalesRange(range) {
    const cards = document.querySelectorAll('.sales-card');
    cards.forEach(card => card.style.display = 'none');

    if (range === 'all') {
        cards.forEach(card => card.style.display = 'block');
    } else {
        const targetCard = document.getElementById(`sales-card-${range}`);
        if (targetCard) targetCard.style.display = 'block';
    }
}

/* ระบบค้นหาและแบ่งหน้าตารางแอดมิน (Pagination & Search) */
function filterAndPaginateTable(tableBodyId, searchInputId, paginationContainerId, pageSize = 5) {
    const tableBody = document.getElementById(tableBodyId);
    const paginationContainer = document.getElementById(paginationContainerId);
    if (!tableBody) return;

    const query = document.getElementById(searchInputId) ? document.getElementById(searchInputId).value.trim().toLowerCase() : '';
    const allRows = Array.from(tableBody.querySelectorAll('tr')).filter(r => !r.id.startsWith('empty'));

    if (allRows.length === 0) {
        if (paginationContainer) paginationContainer.innerHTML = '';
        return;
    }

    const matchingRows = allRows.filter(row => {
        const text = row.innerText.toLowerCase();
        return text.includes(query);
    });

    allRows.forEach(r => r.style.display = 'none');

    if (matchingRows.length === 0) {
        if (paginationContainer) paginationContainer.innerHTML = '<span style="color:#888; font-size:0.85rem;">ไม่พบรายการที่ค้นหา</span>';
        return;
    }

    if (!tablePaginationState[tableBodyId]) {
        tablePaginationState[tableBodyId] = { page: 1, pageSize: pageSize };
    }

    const totalPages = Math.ceil(matchingRows.length / pageSize);
    if (tablePaginationState[tableBodyId].page > totalPages) {
        tablePaginationState[tableBodyId].page = 1;
    }
    const currentPage = tablePaginationState[tableBodyId].page;

    const startIndex = (currentPage - 1) * pageSize;
    const endIndex = startIndex + pageSize;

    matchingRows.slice(startIndex, endIndex).forEach(row => {
        row.style.display = '';
    });

    if (paginationContainer) {
        renderPaginationControls(tableBodyId, searchInputId, paginationContainerId, totalPages, currentPage, pageSize);
    }
}

function renderPaginationControls(tableBodyId, searchInputId, paginationContainerId, totalPages, currentPage, pageSize) {
    const paginationContainer = document.getElementById(paginationContainerId);
    if (!paginationContainer) return;

    if (totalPages <= 1) {
        paginationContainer.innerHTML = '';
        return;
    }

    let html = `<button class="page-btn" ${currentPage === 1 ? 'disabled' : ''} onclick="changeTablePage('${tableBodyId}', '${searchInputId}', '${paginationContainerId}', ${currentPage - 1}, ${pageSize})">◀ ก่อนหน้า</button>`;

    for (let i = 1; i <= totalPages; i++) {
        html += `<button class="page-btn ${i === currentPage ? 'active' : ''}" onclick="changeTablePage('${tableBodyId}', '${searchInputId}', '${paginationContainerId}', ${i}, ${pageSize})">${i}</button>`;
    }

    html += `<button class="page-btn" ${currentPage === totalPages ? 'disabled' : ''} onclick="changeTablePage('${tableBodyId}', '${searchInputId}', '${paginationContainerId}', ${currentPage + 1}, ${pageSize})">ถัดไป ▶</button>`;

    paginationContainer.innerHTML = html;
}

function changeTablePage(tableBodyId, searchInputId, paginationContainerId, newPage, pageSize) {
    if (!tablePaginationState[tableBodyId]) {
        tablePaginationState[tableBodyId] = { page: 1, pageSize: pageSize };
    }
    tablePaginationState[tableBodyId].page = newPage;
    filterAndPaginateTable(tableBodyId, searchInputId, paginationContainerId, pageSize);
}

function initAllAdminPaginations() {
    filterAndPaginateTable('pendingSalonTableBody', 'search-pending-salon', 'pagination-pending-salon', 5);
    filterAndPaginateTable('deliveryTableBody', 'search-delivery', 'pagination-delivery', 5);
    filterAndPaginateTable('pendingCustomTableBody', 'search-customs', 'pagination-customs', 5);
    filterAndPaginateTable('customerTableBody', 'search-customers', 'pagination-customers', 5);
}

function autoDetectShippingFee(addressStr) {
    const label = document.getElementById('shippingDetectedLabel');
    const address = (addressStr || '').trim();
    const inProvince = address === '' || address.includes(CONFIG.shop_province);

    autoDetectedShippingFee = inProvince ? CONFIG.shipping_in : CONFIG.shipping_out;
    if (label) {
        if (inProvince) {
            label.innerText = currentLang === 'th'
                ? `ในจังหวัด${CONFIG.shop_province} (${CONFIG.shipping_in} ฿)`
                : `In ${CONFIG.shop_province} (${CONFIG.shipping_in} THB)`;
        } else {
            label.innerText = currentLang === 'th'
                ? `ต่างจังหวัด / นอกพื้นที่ (${CONFIG.shipping_out} ฿)`
                : `Other Provinces (${CONFIG.shipping_out} THB)`;
        }
    }
    calculateCartTotal();
}

function fetchUserPendingPayments() {
    if (currentUserRole !== 'customer') return;

    fetch('/api/user/pending_payments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
    })
    .then(res => res.json())
    .then(data => {
        pendingPaymentsList = data.pending || [];
        customerOrdersList = data.orders || [];
        mySalonQueuesList = data.my_queues || [];
        renderPendingPaymentsUI();
        renderCustomerTrackingUI();
        updateCartBadgeCount();
    })
    .catch(err => console.error(err));
}

function fetchUserPendingPaymentsByInput() {
    fetchUserPendingPayments();
}

function fetchTrackingByInput() {
    fetchUserPendingPayments();
}

function renderPendingPaymentsUI() {
    const section = document.getElementById('pendingPaymentSection');
    const container = document.getElementById('pendingPaymentItems');
    if (!section || !container) return;

    container.innerHTML = '';
    if (pendingPaymentsList.length > 0) {
        section.style.display = 'block';
        pendingPaymentsList.forEach(item => {
            const div = document.createElement('div');
            div.style.cssText = 'display:flex; justify-content:space-between; align-items:center; margin-top:8px; padding-top:8px; border-top:1px dashed #DCC080; font-size:0.85rem;';
            div.innerHTML = `
                <div style="text-align:left;">
                    <strong>${esc(item.service)}</strong><br>
                    <small style="color:#666;">ไซส์: ${esc(item.size)}</small><br>
                    <span style="color:var(--danger-red); font-weight:bold;">ราคา: ${esc(item.price)} ฿ (ค่าส่ง ${esc(item.shipping_fee)} ฿)</span>
                </div>
                <button class="pill-btn" style="padding:4px 10px; font-size:0.75rem; white-space:nowrap;" onclick="payApprovedCustomItem(${Number(item.id)})">ชำระเงินเลย</button>
            `;
            container.appendChild(div);
        });
    } else {
        section.style.display = 'none';
    }
}

function renderCustomerTrackingUI() {
    const container = document.getElementById('modalCustomerTrackingItems');
    if (!container) return;

    let html = '';

    if (mySalonQueuesList.length > 0) {
        html += `<h5 style="color:var(--line-green); margin-top:5px; margin-bottom:5px; font-weight:bold;">💈 คิวจองทำเล็บหน้าร้าน</h5>`;
        mySalonQueuesList.forEach(q => {
            const isApproved = q.status === 'confirmed';
            const statusStr = isApproved ? 'อนุมัติแล้ว (จองสำเร็จ)' : 'รอแอดมินอนุมัติสลิป';
            const statusColor = isApproved ? 'var(--line-green)' : '#D9822B';

            html += `
                <div style="padding: 8px; background: #FFF; border-radius: 8px; margin-bottom: 6px; border: 1px solid var(--line-green); text-align: left; font-size: 0.85rem;">
                    <div style="display:flex; justify-content:space-between; margin-bottom: 3px;">
                        <strong>${esc(q.service)}</strong>
                        <span style="color:${statusColor}; font-weight:bold;">${statusStr}</span>
                    </div>
                    <div style="font-size:0.8rem; color:#555;">วันที่: ${esc(q.date)} (${esc(q.time)} น.)</div>
                    <div style="margin-top:5px; display:flex; gap:6px;">
                        ${q.slip_path ? `<a href="${esc(fileUrl(q.slip_path))}" target="_blank" class="slip-link-btn" style="font-size:0.7rem;">ดูสลิปที่ส่ง</a>` : ''}
                        <button class="pill-btn" style="padding:2px 8px; font-size:0.7rem;" onclick="viewReceiptById(${Number(q.id)})">🧾 ดูใบเสร็จ</button>
                    </div>
                </div>
            `;
        });
    }

    if (customerOrdersList.length > 0) {
        html += `<h5 style="color:var(--line-green); margin-top:8px; margin-bottom:5px; font-weight:bold;">💅 ออเดอร์สั่งซื้อเล็บปลอม</h5>`;
        customerOrdersList.forEach(o => {
            const isApproved = o.status === 'confirmed';
            const statusStr = isApproved ? esc(o.delivery_status || 'กำลังเตรียมจัดส่ง') : 'รอแอดมินอนุมัติสลิป';
            const statusColor = isApproved ? 'var(--line-green)' : '#D9822B';

            html += `
                <div style="padding: 8px; background: #FFF; border-radius: 8px; margin-bottom: 6px; border: 1px solid var(--accent-green); text-align: left; font-size: 0.85rem;">
                    <div style="display:flex; justify-content:space-between; margin-bottom: 3px;">
                        <strong>#ORDER-${Number(o.id)} (${esc(o.service)})</strong>
                        <span style="color:${statusColor}; font-weight:bold;">${statusStr}</span>
                    </div>
                    <div style="font-size: 0.8rem; color: #555;">ที่อยู่: ${esc(o.address || 'ไม่ระบุ')}</div>
                    <div style="font-size: 0.8rem; color: #333; margin-top:2px;">
                        เลขพัสดุ: <code style="background:#E8E8E8; padding:1px 6px; font-size:0.8rem;">${esc(o.tracking_number || '-')}</code>
                    </div>
                    <div style="margin-top:5px; display:flex; gap:6px;">
                        ${o.slip_path ? `<a href="${esc(fileUrl(o.slip_path))}" target="_blank" class="slip-link-btn" style="font-size:0.7rem;">ดูสลิปชำระเงิน</a>` : ''}
                        <button class="pill-btn" style="padding:2px 8px; font-size:0.7rem;" onclick="viewReceiptById(${Number(o.id)})">🧾 ดูใบเสร็จ</button>
                    </div>
                </div>
            `;
        });
    }

    container.innerHTML = html || '<p style="color:#888; text-align:center; padding:10px;">ยังไม่มีรายการสั่งซื้อหรือคิวจอง</p>';
}

function openTrackingModal() {
    fetchUserPendingPayments();
    const modal = document.getElementById('trackingModal');
    if (modal) modal.style.display = 'flex';
}

function closeTrackingModal() {
    const modal = document.getElementById('trackingModal');
    if (modal) modal.style.display = 'none';
}

function viewReceiptById(queueId) {
    const allItems = [...customerOrdersList, ...mySalonQueuesList];
    const found = allItems.find(i => i.id == queueId);
    if (found) {
        showReceiptModal(found);
    } else {
        alert('ไม่พบข้อมูลใบเสร็จ');
    }
}

function approveSalonBooking(queueId) {
    if (!confirm('ยืนยันอนุมัติคิวจองทำเล็บและตรวจสอบสลิปใช่หรือไม่?')) return;

    fetch('/api/admin/approve_salon_booking', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ queue_id: queueId })
    })
    .then(res => res.json())
    .then(data => {
        if (data.status === 'success') {
            alert(data.message);
            const row = document.getElementById(`pending-salon-row-${queueId}`);
            if (row) row.remove();
            addQueueToTableRealtime(data.queue);
            filterAndPaginateTable('pendingSalonTableBody', 'search-pending-salon', 'pagination-pending-salon', 5);
            fetchSalesReport();
        } else {
            alert('เกิดข้อผิดพลาด: ' + data.message);
        }
    })
    .catch(err => console.error(err));
}

function approvePressOnOrder(queueId) {
    if (!confirm('ยืนยันตรวจสอบสลิปโอนเงิน และอนุมัติออเดอร์จัดส่งสินค้าใช่หรือไม่?')) return;

    fetch('/api/admin/approve_presson_order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ queue_id: queueId })
    })
    .then(res => res.json())
    .then(data => {
        if (data.status === 'success') {
            alert(data.message);
            location.reload();
        } else {
            alert('เกิดข้อผิดพลาด: ' + data.message);
        }
    })
    .catch(err => console.error(err));
}

function submitUserReview() {
    const name = document.getElementById('rev_name') ? document.getElementById('rev_name').value.trim() : '';
    const phone = document.getElementById('rev_phone') ? document.getElementById('rev_phone').value.trim() : '';
    const rating = document.getElementById('rev_rating') ? document.getElementById('rev_rating').value : '5';
    const comment = document.getElementById('rev_comment') ? document.getElementById('rev_comment').value.trim() : '';
    const imgFile = document.getElementById('rev_image') ? document.getElementById('rev_image').files[0] : null;

    if (!name || !phone || !comment) {
        alert('กรุณากรอกชื่อ เบอร์โทร และคำรีวิวให้ครบถ้วน');
        return;
    }

    const formData = new FormData();
    formData.append('name', name);
    formData.append('phone', phone);
    formData.append('rating', rating);
    formData.append('comment', comment);
    if (imgFile) formData.append('image', imgFile);

    fetch('/api/review/add', {
        method: 'POST',
        body: formData
    })
    .then(res => res.json())
    .then(data => {
        if (data.status === 'success') {
            alert(data.message);
            location.reload();
        } else {
            alert('เกิดข้อผิดพลาด: ' + data.message);
        }
    })
    .catch(err => console.error(err));
}

function saveDeliveryStatus(queueId) {
    const statusSelect = document.getElementById(`delivery-status-select-${queueId}`);
    const trackingInput = document.getElementById(`tracking-input-${queueId}`);

    if (!statusSelect || !trackingInput) return;

    const statusVal = statusSelect.value;
    const trackingVal = trackingInput.value.trim() || '-';

    fetch('/api/owner/update_delivery', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            queue_id: queueId,
            delivery_status: statusVal,
            tracking_number: trackingVal
        })
    })
    .then(res => res.json())
    .then(data => {
        if (data.status === 'success') {
            alert('บันทึกสถานะจัดส่งเรียบร้อยแล้ว');
        } else {
            alert('เกิดข้อผิดพลาด: ' + data.message);
        }
    })
    .catch(err => console.error(err));
}

function deleteDeliveryOrder(queueId) {
    if (!confirm(`คุณต้องการลบออเดอร์ ID #${queueId} ใช่หรือไม่?`)) return;

    fetch(`/api/queue/delete/${queueId}`, { method: 'POST' })
    .then(res => res.json())
    .then(data => {
        if (data.status === 'success') {
            const row = document.getElementById(`delivery-row-${queueId}`);
            if (row) row.remove();
            filterAndPaginateTable('deliveryTableBody', 'search-delivery', 'pagination-delivery', 5);
            alert(data.message);
        } else {
            alert('เกิดข้อผิดพลาด: ' + data.message);
        }
    })
    .catch(err => console.error(err));
}

function deleteCustomer(userId) {
    if (!confirm(`คุณต้องการลบข้อมูลลูกค้ารายนี้ใช่หรือไม่?`)) return;

    fetch(`/api/customer/delete/${userId}`, { method: 'POST' })
    .then(res => res.json())
    .then(data => {
        if (data.status === 'success') {
            const row = document.getElementById(`customer-row-${userId}`);
            if (row) row.remove();
            filterAndPaginateTable('customerTableBody', 'search-customers', 'pagination-customers', 5);
            alert(data.message);
        } else {
            alert('เกิดข้อผิดพลาด: ' + data.message);
        }
    })
    .catch(err => console.error(err));
}

function updateCartBadgeCount() {
    safeSetText('cart-badge', cart.length + pendingPaymentsList.length);
    safeSetText('track-badge', customerOrdersList.length + mySalonQueuesList.length);
}

function openAddCartModal(serviceName, price) {
    if (!requireCustomerAuth()) return;

    pendingCartItem = { name: serviceName, price: price };
    safeSetText('sizeModalTitle', `เลือกไซส์เล็บสำหรับ ${serviceName}`);
    
    const group = document.getElementById('customSizeGroup');
    if (group) group.style.display = 'none';
    
    safeSetValue('modal_nail_size', 'M');
    
    const modal = document.getElementById('sizeSelectModal');
    if (modal) modal.style.display = 'flex';
}

function closeSizeSelectModal() {
    const modal = document.getElementById('sizeSelectModal');
    if (modal) modal.style.display = 'none';
    pendingCartItem = null;
}

function toggleCustomSizeInput(val) {
    const group = document.getElementById('customSizeGroup');
    if (group) group.style.display = (val === 'Custom') ? 'block' : 'none';
}

function confirmAddToCart() {
    if (!pendingCartItem) return;

    const sizeSelect = document.getElementById('modal_nail_size');
    let selectedSize = sizeSelect ? sizeSelect.value : 'M';

    if (selectedSize === 'Custom') {
        const textInput = document.getElementById('modal_custom_size_text');
        const customText = textInput ? textInput.value.trim() : '';
        if (!customText) {
            alert('กรุณากรอกรายละเอียดไซส์เล็บของคุณ');
            return;
        }
        selectedSize = `Custom (${customText})`;
    }

    const addedName = pendingCartItem.name;
    cart.push({
        id: Date.now(),
        name: addedName,
        price: pendingCartItem.price,
        size: selectedSize
    });

    saveCartToStorage();
    updateCartUI();
    closeSizeSelectModal();
    alert(`เพิ่ม ${addedName} (ไซส์: ${selectedSize}) ลงในตะกร้าเรียบร้อยแล้ว`);
}

function updateCartUI() {
    const container = document.getElementById('cartItemsContainer');
    if (!container) return;

    container.innerHTML = '';

    if (cart.length === 0) {
        container.innerHTML = '<p class="text-center" style="color:#888; padding: 15px;">ไม่มีสินค้าทั่วไปในตะกร้า</p>';
    } else {
        cart.forEach((item, index) => {
            const row = document.createElement('div');
            row.className = 'cart-item-row';
            row.innerHTML = `
                <div style="text-align: left;">
                    <strong>${esc(item.name)}</strong><br>
                    <small style="color:#666;">ไซส์: ${esc(item.size)}</small>
                </div>
                <div style="display: flex; align-items: center; gap: 10px;">
                    <span style="font-weight: bold;">${esc(item.price)} ฿</span>
                    <button class="delete-btn" style="padding:2px 8px;" onclick="removeFromCart(${index})">X</button>
                </div>
            `;
            container.appendChild(row);
        });
    }

    updateCartBadgeCount();
    calculateCartTotal();
}

function removeFromCart(index) {
    cart.splice(index, 1);
    saveCartToStorage();
    updateCartUI();
}

function calculateCartTotal() {
    // ตัวเลขนี้ใช้แสดงผลเท่านั้น เซิร์ฟเวอร์จะคำนวณยอดจริงใหม่จากตารางราคาตอนสั่งซื้อ
    const subtotal = cart.reduce((sum, item) => sum + Number(item.price || 0), 0);
    let shippingFee = (cart.length > 0) ? autoDetectedShippingFee : 0;

    const notice = document.getElementById('freeShippingNotice');
    if (subtotal >= CONFIG.free_shipping_threshold) {
        shippingFee = 0;
        if (notice) notice.style.display = 'block';
    } else if (notice) {
        notice.style.display = 'none';
    }

    const vatAmount = round2(subtotal * CONFIG.vat_rate);
    const discount = round2(subtotal * appliedCouponRate);
    currentDiscountAmount = discount;

    const finalTotal = Math.max(0, round2(subtotal + shippingFee + vatAmount - discount));

    safeSetText('cartSubtotal', `${subtotal.toFixed(2)} ฿`);
    safeSetText('cartShippingFee', `${shippingFee.toFixed(2)} ฿`);
    safeSetText('cartVAT', `${vatAmount.toFixed(2)} ฿`);
    safeSetText('cartDiscount', `-${discount.toFixed(2)} ฿`);
    safeSetText('cartTotalPrice', `${finalTotal.toFixed(2)} ฿`);

    return { subtotal, shippingFee, vatAmount, discount, finalTotal };
}

function applyCoupon() {
    const input = document.getElementById('coupon_code');
    const code = input ? input.value.trim().toUpperCase() : '';
    const msg = document.getElementById('couponMsg');

    const showMsg = (text, ok) => {
        if (msg) {
            msg.style.color = ok ? 'var(--line-green)' : 'var(--danger-red)';
            msg.innerText = text;
        }
    };

    if (!code) {
        showMsg('กรุณากรอกโค้ดส่วนลด', false);
        return;
    }
    if (!requireCustomerAuth()) return;

    fetch('/api/check_coupon', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: code })
    })
    .then(res => res.json())
    .then(data => {
        if (data.status === 'success') {
            appliedCouponCode = code;
            appliedCouponRate = Number(data.rate) || 0;
            showMsg(data.message, true);
        } else {
            appliedCouponCode = '';
            appliedCouponRate = 0;
            showMsg(data.message, false);
        }
        calculateCartTotal();
    })
    .catch(err => console.error(err));
}

function showQrModal({ serviceText, amount, amountSuffix = '', note }) {
    const name = currentUser ? `${currentUser.fname} ${currentUser.lname}` : '';
    safeSetText('qrCustomerName', `คุณ ${name}`);
    safeSetText('qrServiceName', serviceText);
    safeSetText('qrAmountText', `${amount.toFixed(2)} บาท${amountSuffix}`);
    safeSetText('qrNoteText', note);

    const qrImg = document.getElementById('qrImageModal');
    if (qrImg) qrImg.src = `https://promptpay.io/${CONFIG.promptpay_id}/${amount.toFixed(2)}.png`;

    const modal = document.getElementById('qrModal');
    if (modal) modal.style.display = 'flex';
}

function payApprovedCustomItem(queueId) {
    if (!requireCustomerAuth()) return;

    const item = pendingPaymentsList.find(i => i.id == queueId);
    if (!item) {
        alert('ไม่พบรายการที่ต้องการชำระเงิน');
        return;
    }

    const price = Number(item.price) || 0;
    const shipping = Number(item.shipping_fee) || 0;
    const total = round2(price + shipping + round2(price * CONFIG.vat_rate));

    closeCartModal();
    currentPendingOrderData = { queue_id: item.id, isCart: false };

    showQrModal({
        serviceText: `รายการ Custom: ${item.service}`,
        amount: total,
        note: '* ชำระเงินค่าสั่งทำเล็บปลอม Custom ตามราคาประเมินและค่าจัดส่งของร้าน'
    });
}

function openCartModal() {
    if (!requireCustomerAuth()) return;
    fetchUserPendingPayments();
    updateCartUI();
    const modal = document.getElementById('cartModal');
    if (modal) modal.style.display = 'flex';
}

function closeCartModal() {
    const modal = document.getElementById('cartModal');
    if (modal) modal.style.display = 'none';
}

function checkoutCart() {
    if (!requireCustomerAuth()) return;

    if (cart.length === 0) {
        alert('ตะกร้าสินค้าของคุณยังไม่มีสินค้า');
        return;
    }

    const addressInput = document.getElementById('cart_address');
    const address = addressInput ? addressInput.value.trim() : '';
    if (!address) {
        alert('กรุณากรอกที่อยู่จัดส่งสำหรับเล็บปลอม');
        return;
    }

    autoDetectShippingFee(address);
    const totals = calculateCartTotal();
    closeCartModal();

    currentPendingOrderData = {
        items: cart.map(i => ({ name: i.name, size: i.size })),
        address: address,
        coupon_code: appliedCouponRate ? appliedCouponCode : '',
        isCart: true
    };

    showQrModal({
        serviceText: `รายการ: ${cart.map(i => i.name).join(', ')}`,
        amount: totals.finalTotal,
        note: '* รวมค่าสินค้า + ค่าจัดส่ง + VAT 7% - ส่วนลด'
    });
}

function openCustomEstimateModal() {
    if (!requireCustomerAuth()) return;
    const modal = document.getElementById('customEstimateModal');
    if (modal) modal.style.display = 'flex';
}

function closeCustomEstimateModal() {
    const modal = document.getElementById('customEstimateModal');
    if (modal) modal.style.display = 'none';
}

function submitCustomEstimate() {
    const fname = document.getElementById('est_fname') ? document.getElementById('est_fname').value.trim() : '';
    const lname = document.getElementById('est_lname') ? document.getElementById('est_lname').value.trim() : '';
    const ig_line = document.getElementById('est_ig_line') ? document.getElementById('est_ig_line').value.trim() : '';
    const phone = document.getElementById('est_phone') ? document.getElementById('est_phone').value.trim() : '';
    const size = document.getElementById('est_size') ? document.getElementById('est_size').value : 'M';
    const address = document.getElementById('est_address') ? document.getElementById('est_address').value.trim() : '';
    const fileInput = document.getElementById('est_file');

    if (!fname || !lname || !ig_line || !phone || !address || !fileInput || !fileInput.files.length) {
        alert('กรุณากรอกข้อมูล ที่อยู่จัดส่ง และอัปโหลดรูปภาพให้ครบถ้วน');
        return;
    }

    if (!/^\d{9,10}$/.test(phone)) {
        alert('กรุณากรอกเบอร์โทรศัพท์เป็นตัวเลข 9-10 หลัก');
        return;
    }

    const formData = new FormData();
    formData.append('fname', fname);
    formData.append('lname', lname);
    formData.append('ig_line', ig_line);
    formData.append('phone', phone);
    formData.append('size', size);
    formData.append('address', address);
    formData.append('custom_img', fileInput.files[0]);

    fetch('/api/custom_estimate', {
        method: 'POST',
        body: formData
    })
    .then(res => res.json())
    .then(data => {
        if (data.status === 'success') {
            alert(data.message);
            closeCustomEstimateModal();
            fetchUserPendingPayments(phone);
        } else {
            alert('เกิดข้อผิดพลาด: ' + data.message);
        }
    })
    .catch(err => console.error(err));
}

function openAddServiceModal(category) {
    safeSetText('manageServiceTitle', category === 'booking' ? 'เพิ่มบริการทำเล็บหน้าร้านใหม่' : 'เพิ่มสินค้าเล็บปลอมใหม่');
    safeSetValue('edit_service_id', '');
    safeSetValue('svc_category', category);
    
    const form = document.getElementById('manageServiceForm');
    if (form) form.reset();
    
    const modal = document.getElementById('manageServiceModal');
    if (modal) modal.style.display = 'flex';
}

function openEditServiceModal(id, name, price, category) {
    safeSetText('manageServiceTitle', `แก้ไขรายการ #${id}`);
    safeSetValue('edit_service_id', id);
    safeSetValue('svc_category', category);
    safeSetValue('svc_name', name);
    safeSetValue('svc_price', price);
    
    const modal = document.getElementById('manageServiceModal');
    if (modal) modal.style.display = 'flex';
}

function closeManageServiceModal() {
    const modal = document.getElementById('manageServiceModal');
    if (modal) modal.style.display = 'none';
}

function saveServiceItem() {
    const editId = document.getElementById('edit_service_id') ? document.getElementById('edit_service_id').value : '';
    const category = document.getElementById('svc_category') ? document.getElementById('svc_category').value : 'custom';
    const name = document.getElementById('svc_name') ? document.getElementById('svc_name').value.trim() : '';
    const price = document.getElementById('svc_price') ? document.getElementById('svc_price').value : '0';
    const imgFile = document.getElementById('svc_image') ? document.getElementById('svc_image').files[0] : null;

    if (!name || !price || parseFloat(price) <= 0) {
        alert('กรุณากรอกชื่อและราคาให้ถูกต้อง');
        return;
    }

    const formData = new FormData();
    formData.append('name', name);
    formData.append('price', price);
    formData.append('category', category);
    if (imgFile) formData.append('image', imgFile);

    let url = '/api/admin/add_service';
    if (editId) {
        formData.append('service_id', editId);
        url = '/api/admin/edit_service';
    }

    fetch(url, {
        method: 'POST',
        body: formData
    })
    .then(res => res.json())
    .then(data => {
        if (data.status === 'success') {
            alert(data.message);
            closeManageServiceModal();
            location.reload();
        } else {
            alert('เกิดข้อผิดพลาด: ' + data.message);
        }
    })
    .catch(err => console.error(err));
}

function deleteServiceItem(serviceId) {
    if (!confirm(`คุณต้องการลบรายการ ID #${serviceId} ออกจากระบบใช่หรือไม่?`)) return;

    fetch(`/api/admin/delete_service/${serviceId}`, { method: 'POST' })
    .then(res => res.json())
    .then(data => {
        if (data.status === 'success') {
            alert(data.message);
            const card = document.getElementById(`service-card-${serviceId}`);
            if (card) card.remove();
        } else {
            alert('เกิดข้อผิดพลาด: ' + data.message);
        }
    })
    .catch(err => console.error(err));
}

function approveCustomPrice(queueId) {
    const priceInput = document.getElementById(`price-input-${queueId}`);
    const shippingInput = document.getElementById(`shipping-input-${queueId}`);
    if (!priceInput || !shippingInput) return;

    const approvedPrice = priceInput.value;
    const approvedShipping = shippingInput.value;

    if (!approvedPrice || parseFloat(approvedPrice) <= 0) {
        alert('กรุณากรอกราคาประเมินที่ถูกต้อง');
        return;
    }

    fetch('/api/owner/approve_custom', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            queue_id: queueId,
            price: approvedPrice,
            shipping_fee: approvedShipping || 50
        })
    })
    .then(res => res.json())
    .then(data => {
        if (data.status === 'success') {
            alert(data.message);
            const row = document.getElementById(`pending-custom-row-${queueId}`);
            if (row) row.remove();
            filterAndPaginateTable('pendingCustomTableBody', 'search-customs', 'pagination-customs', 5);
        } else {
            alert('เกิดข้อผิดพลาด: ' + data.message);
        }
    })
    .catch(err => console.error(err));
}

function openPaymentModal() {
    if (!requireCustomerAuth()) return;

    const serviceSelect = document.getElementById('cust_service');
    if (!serviceSelect || serviceSelect.selectedIndex <= 0) {
        alert('กรุณาเลือกรายการบริการทำเล็บก่อนครับ');
        return;
    }

    const service = serviceSelect.options[serviceSelect.selectedIndex].value;
    const dateInput = document.getElementById('book_date');
    const timeInput = document.getElementById('book_time');
    const date = dateInput ? dateInput.value : '';
    const time = timeInput ? timeInput.value : '';

    if (!date || !time) {
        alert('กรุณาเลือกวันที่และเวลาที่ต้องการเข้ารับบริการก่อนครับ');
        return;
    }

    currentPendingOrderData = { service: service, date: date, time: time, isCart: false };

    showQrModal({
        serviceText: `รายการ: ${service}`,
        amount: Number(CONFIG.deposit),
        amountSuffix: ' (มัดจำคิว)',
        note: `* ค่ามัดจำคิว ${CONFIG.deposit} บาท (หากมาเลทเกิน 15 นาที มัดจำจะถูกริบ)`
    });
}

function submitFinalOrder() {
    if (isSubmittingOrder) return;

    const slipFileInput = document.getElementById('slip_file');
    if (!slipFileInput || !slipFileInput.files || slipFileInput.files.length === 0) {
        alert('กรุณาแนบไฟล์สลิปชำระเงินก่อนยืนยันครับ');
        return;
    }
    if (!currentPendingOrderData) {
        alert('ไม่พบข้อมูลการสั่งซื้อ กรุณาลองใหม่อีกครั้ง');
        return;
    }

    // ส่งเฉพาะ "สิ่งที่ลูกค้าเลือก" ราคา ค่าส่ง VAT ส่วนลด เซิร์ฟเวอร์คำนวณเอง
    const order = currentPendingOrderData;
    const wasCart = order.isCart;
    const formData = new FormData();

    if (order.queue_id) {
        formData.append('queue_id', order.queue_id);
    } else if (order.items) {
        formData.append('items', JSON.stringify(order.items));
        formData.append('address', order.address || '');
        formData.append('coupon_code', order.coupon_code || '');
    } else {
        formData.append('service', order.service);
        formData.append('date', order.date);
        formData.append('time', order.time);
    }
    formData.append('slip', slipFileInput.files[0]);

    const submitBtn = document.querySelector('button[onclick*="submitFinalOrder"]');
    isSubmittingOrder = true;
    if (submitBtn) submitBtn.disabled = true;

    fetch('/api/order', { method: 'POST', body: formData })
    .then(async response => {
        let data = {};
        try { data = await response.json(); } catch (e) { /* ไม่ใช่ JSON */ }

        if (response.ok && data.status === 'success') {
            alert(data.message);

            if (wasCart) {
                cart = [];
                appliedCouponCode = '';
                appliedCouponRate = 0;
                saveCartToStorage();
                updateCartUI();
            }

            closeQRModal();
            showReceiptModal(data.queue);

            slipFileInput.value = '';
            const fields = document.getElementById('booking_fields');
            if (fields) fields.style.display = 'none';

            fetchUserPendingPayments();
            updateAvailableSlots();
        } else {
            alert('เกิดข้อผิดพลาด: ' + (data.message || 'Server error'));
        }
    })
    .catch(error => {
        console.error('Fetch Error:', error);
        alert('เกิดข้อผิดพลาดในการเชื่อมต่อเซิร์ฟเวอร์');
    })
    .finally(() => {
        isSubmittingOrder = false;
        if (submitBtn) submitBtn.disabled = false;
    });
}

function showReceiptModal(queueData) {
    safeSetText('rec_id', `#ORDER-${queueData.id}`);
    safeSetText('rec_name', queueData.name);
    safeSetText('rec_phone', queueData.phone);
    safeSetText('rec_ig', queueData.ig_line);
    safeSetText('rec_service', queueData.service);
    safeSetText('rec_size', queueData.size || '-');
    safeSetText('rec_address', queueData.address || 'เข้ารับบริการที่ร้าน');
    safeSetText('rec_datetime', `${queueData.date} (${queueData.time})`);
    safeSetText('rec_amount', queueData.price || 0);

    const vatRow = document.getElementById('rec_vat_row');
    if (queueData.vat && queueData.vat > 0) {
        if (vatRow) vatRow.style.display = 'block';
        safeSetText('rec_vat', queueData.vat.toFixed(1));
    } else {
        if (vatRow) vatRow.style.display = 'none';
    }

    const modal = document.getElementById('receiptModal');
    if (modal) modal.style.display = 'flex';
}

function closeReceiptModal() {
    const modal = document.getElementById('receiptModal');
    if (modal) modal.style.display = 'none';
    currentPendingOrderData = null;
}

function addQueueToTableRealtime(q) {
    // ใช้เฉพาะตอนแอดมินอนุมัติคิวจอง (ตารางคิวสาธารณะ)
    if (!q || q.order_type !== 'salon') return;

    const tableBody = document.getElementById('queueTableBody');
    if (!tableBody) return;

    const emptyRow = document.getElementById('emptyQueueRow');
    if (emptyRow) emptyRow.remove();

    const newRow = document.createElement('tr');
    newRow.id = `queue-row-${q.id}`;
    newRow.setAttribute('data-id', q.id);
    newRow.setAttribute('data-raw-name', q.name || '');
    newRow.setAttribute('data-phone', q.phone || '');
    newRow.setAttribute('data-ig', q.ig_line || '');
    newRow.setAttribute('data-date', q.date || '');
    newRow.setAttribute('data-time', q.time || '');
    newRow.setAttribute('data-service', q.service || '');
    newRow.style.backgroundColor = '#eef7ea';

    newRow.innerHTML = `
        <td class="col-date">${esc(q.date)}</td>
        <td class="col-time">${esc(q.time)}</td>
        <td class="col-name">${esc(q.name)}</td>
        <td class="col-service">${esc(q.service)}</td>
        <td class="col-size">${esc(q.size || '-')}</td>
        <td class="col-ig admin-only-col" style="display:table-cell;">${esc(q.ig_line)}</td>
        <td class="col-slip admin-only-col" style="display:table-cell;">
            ${q.slip_path ? `<a href="${esc(fileUrl(q.slip_path))}" target="_blank" class="slip-link-btn">ดูสลิป</a>` : '-'}
        </td>
        <td class="col-action admin-only-col" style="display:table-cell;">
            <button class="delete-btn" onclick="deleteSingleQueue(${Number(q.id)})">ลบคิว</button>
        </td>
    `;

    tableBody.insertBefore(newRow, tableBody.firstChild);
    updateQueueVisibility();

    setTimeout(() => {
        newRow.style.backgroundColor = 'transparent';
    }, 3000);
}

function closeQRModal() {
    const modal = document.getElementById('qrModal');
    if (modal) modal.style.display = 'none';
}

function selectForOrder(name) {
    if (!requireCustomerAuth()) return;

    const select = document.getElementById('cust_service');
    if (select) {
        for (let i = 0; i < select.options.length; i++) {
            if (select.options[i].value === name) {
                select.selectedIndex = i;
                break;
            }
        }
    }
    checkServiceType();
    updateAvailableSlots();
    
    const el = document.getElementById('custom');
    if (el) el.scrollIntoView({ behavior: 'smooth' });
}

function updateQueueVisibility() {
    const rows = document.querySelectorAll('#queueTableBody tr:not(#emptyQueueRow)');
    const toggleBtn = document.getElementById('toggleQueueBtn');

    if (rows.length <= 5) {
        rows.forEach(row => row.style.display = '');
        if (toggleBtn) toggleBtn.style.display = 'none';
        return;
    }

    if (toggleBtn) toggleBtn.style.display = 'inline-block';

    if (isQueueExpanded) {
        rows.forEach(row => row.style.display = '');
        if (toggleBtn) toggleBtn.innerText = currentLang === 'th' ? 'ย่อรายการคิว' : 'Collapse';
    } else {
        rows.forEach((row, index) => {
            if (index < 5) {
                row.style.display = '';
            } else {
                row.style.display = 'none';
            }
        });
        if (toggleBtn) toggleBtn.innerText = currentLang === 'th' ? `ดูคิวทั้งหมด (${rows.length} รายการ)` : `View All (${rows.length})`;
    }
}

function toggleQueueExpansion() {
    isQueueExpanded = !isQueueExpanded;
    updateQueueVisibility();
}

function applyQueueMasking() {
    const rows = document.querySelectorAll('#queueTableBody tr');
    const adminCols = document.querySelectorAll('.admin-only-col');
    const adminBlocks = document.querySelectorAll('.admin-only-block');
    const customerOnlyBtns = document.querySelectorAll('.customer-only-btn');

    const howToSection = document.getElementById('how-to');
    const promotionSection = document.getElementById('promotion');
    const catalogSection = document.getElementById('catalog');
    const customOrderSection = document.getElementById('custom');
    const sizeSection = document.getElementById('size');
    const reviewsSection = document.getElementById('reviews');
    const navReviewsItem = document.getElementById('nav-reviews-item');
    const navLinks = document.querySelectorAll('.nav-links li');
    const cartBtn = document.getElementById('cart-icon-btn');
    const trackBtn = document.getElementById('track-icon-btn');
    const userBtn = document.getElementById('user-icon-btn');

    if (currentUserRole === 'admin') {
        if (howToSection) howToSection.style.display = 'none';
        if (promotionSection) promotionSection.style.display = 'none';
        if (catalogSection) catalogSection.style.display = 'block';
        if (customOrderSection) customOrderSection.style.display = 'none';
        if (sizeSection) sizeSection.style.display = 'none';
        if (reviewsSection) reviewsSection.style.display = 'none';
        if (navReviewsItem) navReviewsItem.style.display = 'none';
        if (cartBtn) cartBtn.style.display = 'none';
        if (trackBtn) trackBtn.style.display = 'none';
        if (userBtn) userBtn.style.display = 'none';

        adminBlocks.forEach(b => b.style.display = 'block');
        customerOnlyBtns.forEach(b => b.style.display = 'none');

        navLinks.forEach(li => {
            const link = li.querySelector('a');
            if (link && link.getAttribute('href') !== '#queue' && link.getAttribute('href') !== '#catalog') {
                li.style.display = 'none';
            } else {
                li.style.display = 'inline-block';
            }
        });

        adminCols.forEach(col => col.style.display = 'table-cell');
        
        rows.forEach(row => {
            const rawName = row.getAttribute('data-raw-name');
            const nameCell = row.querySelector('.col-name');
            if (nameCell && rawName) {
                nameCell.innerText = rawName;
            }
        });

        initAllAdminPaginations();
    } else {
        if (howToSection) howToSection.style.display = 'block';
        if (promotionSection) promotionSection.style.display = 'block';
        if (catalogSection) catalogSection.style.display = 'block';
        if (customOrderSection) customOrderSection.style.display = 'block';
        if (sizeSection) sizeSection.style.display = 'block';
        if (reviewsSection) reviewsSection.style.display = 'block';
        if (navReviewsItem) navReviewsItem.style.display = 'inline-block';
        if (cartBtn) cartBtn.style.display = 'flex';
        if (trackBtn) trackBtn.style.display = 'flex';
        if (userBtn) userBtn.style.display = 'inline-block';

        adminBlocks.forEach(b => b.style.display = 'none');
        customerOnlyBtns.forEach(b => b.style.display = 'inline-block');

        navLinks.forEach(li => li.style.display = 'inline-block');
        adminCols.forEach(col => col.style.display = 'none');

        // ชื่อในตารางคิวสาธารณะถูกปิดจากเซิร์ฟเวอร์แล้ว ไม่มีข้อมูลเต็มส่งมาให้ผู้เยี่ยมชม
    }
    updateQueueVisibility();
}

function switchCustMode(mode) {
    const loginBtn = document.getElementById('cust-mode-login-btn');
    const regBtn = document.getElementById('cust-mode-reg-btn');
    const loginForm = document.getElementById('form-cust-login');
    const regForm = document.getElementById('form-cust-reg');

    if (mode === 'login') {
        if (loginBtn) loginBtn.classList.add('active');
        if (regBtn) regBtn.classList.remove('active');
        if (loginForm) loginForm.style.display = 'block';
        if (regForm) regForm.style.display = 'none';
    } else {
        if (regBtn) regBtn.classList.add('active');
        if (loginBtn) loginBtn.classList.remove('active');
        if (regForm) regForm.style.display = 'block';
        if (loginForm) loginForm.style.display = 'none';
    }
}

function handleCustomerLogin() {
    const phoneInput = document.getElementById('login_phone');
    const passInput = document.getElementById('login_pass');
    
    const phone = phoneInput ? phoneInput.value.trim() : '';
    const password = passInput ? passInput.value.trim() : '';

    if (!phone || !password) {
        alert(currentLang === 'th' ? 'กรุณากรอกเบอร์โทรและรหัสผ่าน' : 'Please enter phone and password');
        return;
    }

    if (!/^\d{9,10}$/.test(phone)) {
        alert('กรุณากรอกเบอร์โทรศัพท์เป็นตัวเลข 9-10 หลัก');
        return;
    }

    fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: phone, password: password })
    })
    .then(res => res.json())
    .then(data => {
        if (data.status === 'success') {
            currentUserRole = 'customer';
            const user = data.user;
            saveUserSession('customer', user);

            refreshAuthLabels();
            const logoutElem = document.getElementById('logout-btn');
            if (logoutElem) logoutElem.style.display = 'inline-block';

            safeSetValue('cust_fname', user.fname);
            safeSetValue('cust_lname', user.lname);
            safeSetValue('cust_ig_line', user.ig_line);
            safeSetValue('cust_phone', user.phone);
            safeSetValue('cart_search_phone', user.phone);
            safeSetValue('track_search_phone', user.phone);
            safeSetValue('rev_name', `${user.fname} ${user.lname}`);
            safeSetValue('rev_phone', user.phone);

            loadCartFromStorage(user.phone);
            updateCartUI();
            fetchUserPendingPayments(user.phone);

            applyQueueMasking();
            closeCustomerLoginModal();
            alert(`ยินดีต้อนรับ คุณ${user.fname}`);
        } else {
            alert('เกิดข้อผิดพลาด: ' + data.message);
        }
    })
    .catch(err => console.error(err));
}

function handleCustomerRegister() {
    const fname = document.getElementById('reg_fname') ? document.getElementById('reg_fname').value.trim() : '';
    const lname = document.getElementById('reg_lname') ? document.getElementById('reg_lname').value.trim() : '';
    const ig = document.getElementById('reg_ig') ? document.getElementById('reg_ig').value.trim() : '';
    const phone = document.getElementById('reg_phone') ? document.getElementById('reg_phone').value.trim() : '';
    const password = document.getElementById('reg_pass') ? document.getElementById('reg_pass').value.trim() : '';

    if (!fname || !lname || !ig || !phone || !password) {
        alert('กรุณากรอกข้อมูลให้ครบถ้วน');
        return;
    }

    if (!/^\d{9,10}$/.test(phone)) {
        alert('กรุณากรอกเบอร์โทรศัพท์เป็นตัวเลข 9-10 หลักให้ถูกต้อง');
        return;
    }

    fetch('/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            fname: fname,
            lname: lname,
            ig_line: ig,
            phone: phone,
            password: password
        })
    })
    .then(res => res.json())
    .then(data => {
        if (data.status === 'success') {
            currentUserRole = 'customer';
            const user = data.user;
            saveUserSession('customer', user);

            refreshAuthLabels();
            const logoutElem = document.getElementById('logout-btn');
            if (logoutElem) logoutElem.style.display = 'inline-block';

            safeSetValue('cust_fname', user.fname);
            safeSetValue('cust_lname', user.lname);
            safeSetValue('cust_ig_line', user.ig_line);
            safeSetValue('cust_phone', user.phone);
            safeSetValue('cart_search_phone', user.phone);
            safeSetValue('track_search_phone', user.phone);

            loadCartFromStorage(user.phone);
            updateCartUI();

            applyQueueMasking();
            closeCustomerLoginModal();
            alert(`สมัครสมาชิกสำเร็จ! ยินดีต้อนรับ คุณ${user.fname}`);
        } else {
            alert('เกิดข้อผิดพลาด: ' + data.message);
        }
    })
    .catch(err => console.error(err));
}

function openCustomerLoginModal() {
    const modal = document.getElementById('customerLoginModal');
    if (modal) modal.style.display = 'flex';
}

function closeCustomerLoginModal() {
    const modal = document.getElementById('customerLoginModal');
    if (modal) modal.style.display = 'none';
}

function openAdminLoginModal() {
    const modal = document.getElementById('adminLoginModal');
    if (modal) modal.style.display = 'flex';
}

function closeAdminLoginModal() {
    const modal = document.getElementById('adminLoginModal');
    if (modal) modal.style.display = 'none';
}

function handleAdminLogin() {
    const passInput = document.getElementById('admin_pass');
    const pass = passInput ? passInput.value : '';

    if (!pass) {
        alert('กรุณากรอกรหัสผ่านแอดมิน');
        return;
    }

    fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pass })
    })
    .then(res => res.json())
    .then(data => {
        if (data.status === 'success') {
            closeAdminLoginModal();
            location.reload();   // เซิร์ฟเวอร์ส่งข้อมูลแอดมินมาให้เมื่อรีโหลดหลังล็อกอินเท่านั้น
        } else {
            alert(data.message || 'รหัสผ่านแอดมินไม่ถูกต้อง');
        }
    })
    .catch(err => console.error(err));
}

function switchLanguage(lang) {
    currentLang = lang;
    const thBtn = document.getElementById('lang-th');
    const enBtn = document.getElementById('lang-en');
    
    if (thBtn) thBtn.classList.toggle('active', lang === 'th');
    if (enBtn) enBtn.classList.toggle('active', lang === 'en');

    const elements = document.querySelectorAll('[data-th][data-en]');
    elements.forEach(el => {
        const text = el.getAttribute(`data-${lang}`);
        if (text) {
            if (el.tagName === 'OPTION') {
                el.text = text;
            } else if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
                el.placeholder = text;
            } else {
                el.innerHTML = text;   // ข้อความใน data-th/data-en เขียนโดยเจ้าของเว็บ รองรับ <br> และ <small>
            }
        }
    });

    refreshAuthLabels();
    renderSalesEditor();

    applyQueueMasking();
    updateAvailableSlots();
}

// ป้ายชื่อบนแถบเมนู: แสดงตามสถานะล็อกอินจริงเสมอ (กันภาษาที่เปลี่ยนไปทับชื่อจนดูเหมือนออกจากระบบ)
function refreshAuthLabels() {
    if (currentUserRole === 'admin') {
        safeSetText('admin-display-name', currentLang === 'th' ? 'แอดมิน (เข้าใช้งาน)' : 'Admin (Active)');
    } else {
        safeSetText('admin-display-name', currentLang === 'th' ? 'แอดมิน' : 'Admin');
    }

    if (currentUserRole === 'customer' && currentUser && currentUser.fname) {
        safeSetText('user-display-name', currentUser.fname);
    } else {
        safeSetText('user-display-name', currentLang === 'th' ? 'เข้าสู่ระบบ' : 'Login');
    }
}

function checkServiceType() {
    const select = document.getElementById('cust_service');
    const bookingFields = document.getElementById('booking_fields');
    if (!select || !bookingFields) return;

    bookingFields.style.display = 'block';
    
    const d = document.getElementById('book_date');
    const t = document.getElementById('book_time');
    if (d) d.required = true;
    if (t) t.required = true;
}

async function updateAvailableSlots() {
    const dateInput = document.getElementById('book_date');
    const timeSelect = document.getElementById('book_time');
    const serviceSelect = document.getElementById('cust_service');
    if (!dateInput || !timeSelect || !serviceSelect) return;

    const selectedDate = dateInput.value;
    const duration = CONFIG.durations[serviceSelect.value] || 1;

    // คิวที่จองแล้วและที่รออนุมัติ (ดึงจากเซิร์ฟเวอร์ ไม่มีข้อมูลส่วนตัว)
    let booked = [];
    if (selectedDate) {
        try {
            const res = await fetch(`/api/booked_slots?date=${encodeURIComponent(selectedDate)}`);
            const data = await res.json();
            booked = data.slots || [];
        } catch (e) {
            console.error('Slots load error:', e);
        }
    }

    const existingBookings = booked.map(b => {
        const start = parseInt(String(b.time).split(':')[0], 10);
        return { start: start, end: start + (CONFIG.durations[b.service] || 1) };
    }).filter(b => !Number.isNaN(b.start));

    for (let i = 0; i < timeSelect.options.length; i++) {
        const opt = timeSelect.options[i];
        if (!opt.value) continue;

        const slotStart = parseInt(opt.value.split(':')[0], 10);
        const slotEnd = slotStart + duration;

        let isBlocked = slotEnd > CONFIG.closing_hour;

        if (!isBlocked && selectedDate === CONFIG.today && slotStart <= CONFIG.now_hour) {
            isBlocked = true;
        }

        if (!isBlocked && selectedDate) {
            isBlocked = existingBookings.some(b => Math.max(slotStart, b.start) < Math.min(slotEnd, b.end));
        }

        const baseLabel = opt.value + ' น.';
        if (isBlocked && selectedDate) {
            opt.disabled = true;
            opt.text = baseLabel + (currentLang === 'en' ? ' (Full)' : ' (คิวเต็ม)');
        } else {
            opt.disabled = false;
            opt.text = baseLabel;
        }
    }
}

function deleteSingleQueue(queueId) {
    if (!confirm(`คุณต้องการลบคิว ID #${queueId} นี้ใช่หรือไม่?`)) return;

    fetch(`/api/queue/delete/${queueId}`, { method: 'POST' })
    .then(res => res.json())
    .then(data => {
        if (data.status === 'success') {
            const row = document.getElementById(`queue-row-${queueId}`);
            if (row) row.remove();
            alert(data.message);
        } else {
            alert('เกิดข้อผิดพลาด: ' + data.message);
        }
    })
    .catch(err => console.error(err));
}

function clearAllQueues() {
    if (!confirm('ยืนยันที่จะล้างรายการคิวทั้งหมดในระบบใช่หรือไม่? รายการจะถูกซ่อนจากระบบ แต่ยอดขายยังคงถูกเก็บไว้')) return;

    fetch('/api/queue/clear_all', { method: 'POST' })
    .then(res => res.json())
    .then(data => {
        if (data.status === 'success') {
            location.reload();
        } else {
            alert('เกิดข้อผิดพลาด: ' + data.message);
        }
    })
    .catch(err => console.error(err));
}

/* แอดมิน: เพิ่มปุ่ม "ปฏิเสธ" ข้างปุ่มอนุมัติในตารางที่เซิร์ฟเวอร์ส่งมา (ไม่ต้องแก้ index.html) */
function injectRejectButtons() {
    if (currentUserRole !== 'admin') return;

    const approveButtons = document.querySelectorAll(
        'button[onclick^="approveSalonBooking("], button[onclick^="approvePressOnOrder("]'
    );
    approveButtons.forEach(btn => {
        if (btn.dataset.rejectAdded) return;
        const match = btn.getAttribute('onclick').match(/\((\d+)\)/);
        if (!match) return;

        const rejectBtn = document.createElement('button');
        rejectBtn.className = 'delete-btn';
        rejectBtn.style.marginLeft = '6px';
        rejectBtn.textContent = 'ปฏิเสธ';
        rejectBtn.addEventListener('click', () => rejectOrder(Number(match[1])));

        btn.dataset.rejectAdded = '1';
        btn.insertAdjacentElement('afterend', rejectBtn);
    });
}

function rejectOrder(queueId) {
    if (!confirm('ยืนยันปฏิเสธรายการนี้ใช่หรือไม่? (เช่น สลิปไม่ถูกต้องหรือยอดไม่ตรง)')) return;

    fetch('/api/admin/reject_order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ queue_id: queueId })
    })
    .then(res => res.json())
    .then(data => {
        if (data.status === 'success') {
            ['pending-salon-row-', 'delivery-row-'].forEach(prefix => {
                const row = document.getElementById(prefix + queueId);
                if (row) row.remove();
            });
            initAllAdminPaginations();
            alert(data.message);
        } else {
            alert('เกิดข้อผิดพลาด: ' + data.message);
        }
    })
    .catch(err => console.error(err));
}