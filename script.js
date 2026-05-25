// Configuración inamovible de Firebase
const firebaseConfig = {
    apiKey: "AIzaSyARv7i6uHqYHiuRfA7jkx8MdzmVKwWqxAo",
    authDomain: "bodega-concha-toro.firebaseapp.com",
    databaseURL: "https://bodega-concha-toro-default-rtdb.firebaseio.com/",
    projectId: "bodega-concha-toro",
    storageBucket: "bodega-concha-toro.firebasestorage.app",
    messagingSenderId: "292866536059",
    appId: "1:292866536059:web:4b69d406debf25d8d468de"
};

firebase.initializeApp(firebaseConfig);
const db = firebase.database();
const auth = firebase.auth();

// Variables Globales base
let ROWS = [];
let PRODUCTS = [];
let HISTORY_LOG = []; 
let ACTIVE_ORDER = [];
let tempImg = null, currentH = null;
let DB_CHANGES = {};

// Variables Globales Nueva Función (Mapa 2D)
let WAREHOUSES = [];
let ZONES = [];
let currentViewMode = 'racks';
let activeWarehouseId = null;

function handleLogin() {
    const emailInput = document.getElementById('loginEmail').value;
    const passInput = document.getElementById('loginPass').value;
    const errEl = document.getElementById('loginError');
    const email = emailInput ? emailInput.trim() : '';
    const pass = passInput ? passInput.trim() : '';

    if (!email || !pass) { errEl.style.display = 'block'; errEl.innerText = "Ingresa correo y contraseña."; return; }
    auth.signInWithEmailAndPassword(email, pass).catch(function(err) {
        errEl.style.display = 'block'; errEl.innerText = "Error de acceso: " + err.message;
    });
}

auth.onAuthStateChanged(function(user) {
    if(user) {
        document.getElementById('loginScreen').style.display = 'none';
        
        db.ref('bodega').on('value', function(snap) {
            const data = snap.val() || {};

            let rawRows = data.rows || [{id:'R1', name:'Fila A', sizeM:15}];
            if (!Array.isArray(rawRows) && typeof rawRows === 'object') { rawRows = Object.keys(rawRows).map(function(k) { return rawRows[k]; }); }
            ROWS = rawRows.filter(function(r) { return r !== null && r !== undefined; });
            if (ROWS.length === 0) ROWS = [{id:'R1', name:'Fila A', sizeM:15}];

            let rawProducts = data.products || [];
            if (!Array.isArray(rawProducts) && typeof rawProducts === 'object') { rawProducts = Object.keys(rawProducts).map(function(k) { return rawProducts[k]; }); }
            PRODUCTS = rawProducts.filter(function(p) { return p !== null && p !== undefined; });

            if (data.history) { HISTORY_LOG = Object.keys(data.history).map(function(k) { return data.history[k]; }).sort(function(a,b) { return new Date(b.dateRaw) - new Date(a.dateRaw); }); } 
            else { HISTORY_LOG = []; }

            // Carga segura de nuevos nodos (Mapa)
            let rawWH = data.warehouses || [];
            if (!Array.isArray(rawWH) && typeof rawWH === 'object') { rawWH = Object.keys(rawWH).map(function(k) { return rawWH[k]; }); }
            WAREHOUSES = rawWH.filter(function(w) { return w !== null && w !== undefined; });
            if (WAREHOUSES.length === 0) WAREHOUSES = [{id: 'WH1', name: 'Bodega Principal', widthM: 30, lengthM: 20, scale: 25}];
            if (!activeWarehouseId) activeWarehouseId = WAREHOUSES[0].id;

            let rawZones = data.zones || [];
            if (!Array.isArray(rawZones) && typeof rawZones === 'object') { rawZones = Object.keys(rawZones).map(function(k) { return rawZones[k]; }); }
            ZONES = rawZones.filter(function(z) { return z !== null && z !== undefined; });

            render();
            if(currentViewMode === 'map') renderMap();
            verificarYEnviarReporteDiario();
        });
    } else {
        document.getElementById('loginScreen').style.display = 'flex';
    }
});

function sync() {
    if(auth.currentUser) {
        db.ref('bodega/rows').set(JSON.parse(JSON.stringify(ROWS)));
        db.ref('bodega/products').set(JSON.parse(JSON.stringify(PRODUCTS)));
        db.ref('bodega/warehouses').set(JSON.parse(JSON.stringify(WAREHOUSES)));
        db.ref('bodega/zones').set(JSON.parse(JSON.stringify(ZONES)));
    }
    render();
    if(currentViewMode === 'map') renderMap();
}

function logMovement(sku, name, changeQty, reason) {
    if (changeQty === 0) return;
    const user = auth.currentUser ? auth.currentUser.email : 'Admin';
    const dateRaw = new Date().toISOString();
    const dateStr = new Date().toLocaleString('es-CL');
    const changeTxt = changeQty > 0 ? '+' + changeQty : changeQty;
    db.ref('bodega/history').push({ date: dateStr, dateRaw: dateRaw, sku: sku, name: name, change: changeTxt, reason: reason, user: user });
}

// RENDER CLÁSICO DE RACKS
function render() {
    const wrap = document.getElementById('whWrap');
    wrap.innerHTML = '';
    let alerts = [];

    const dot = document.getElementById('orderDotStatus');
    if(dot) dot.style.background = ACTIVE_ORDER.length > 0 ? 'var(--order-blue)' : 'grey';

    ROWS.forEach(function(row) {
        const rowProds = PRODUCTS.filter(function(p) { return p && p.rowId === row.id; });
        const used = rowProds.reduce(function(s, p) { return s + (p.widthM || 0); }, 0);
        const perc = row.sizeM > 0 ? ((used / row.sizeM) * 100).toFixed(1) : 0;

        const container = document.createElement('div');
        container.className = 'row-container';
        
        let headerHTML = '<div class="row-header"><div class="row-info"><b>' + row.name + '</b> <span>' + used.toFixed(2) + 'm / ' + row.sizeM + 'm (' + perc + '%)</span></div>';
        headerHTML += '<button class="btn btn-secondary" style="padding:6px 12px; font-size:0.75rem" onclick="openRowModal(\'' + row.id + '\')">⚙️ Editar</button></div>';
        headerHTML += '<div class="row-scroll-wrapper"><div class="wh-row" id="' + row.id + '" ondragover="event.preventDefault()" ondrop="drop(event)"></div></div>';
        
        container.innerHTML = headerHTML;
        const rowEl = container.querySelector('.wh-row');
        
        rowProds.forEach(function(p, index) {
            if(p.current < p.min) alerts.push(p.name);
            const posLabel = row.name.split(' ').pop() + (index + 1);
            
            // CORRECCIÓN: Filtro de iluminación estricto para productos no completados
            const isInActiveOrder = ACTIVE_ORDER.some(function(item) { return item.sku.toLowerCase() === p.sku.toLowerCase() && !item.completed; });

            const pEl = document.createElement('div');
            let classes = 'product';
            if(currentH === p.sku) classes += ' is-highlighted';
            if(isInActiveOrder) classes += ' is-ordered';
            pEl.className = classes;
            pEl.id = 'p-' + p.sku;
            pEl.draggable = true;
            pEl.style.width = (p.widthM / row.sizeM * 100) + '%';
            pEl.style.background = (p.color || '#c8a84b') + '25';
            pEl.style.borderTop = '6px solid ' + (p.color || '#c8a84b');
            
            let tooltipText = 'SKU: ' + p.sku + '\nProducto: ' + p.name + '\nStock Físico: ' + p.current + ' (Mín: ' + p.min + ' / Máx: ' + (p.max || 0) + ')';
            if (p.hasPO) tooltipText += '\n📦 Prov. Reservado: ' + (p.reservedStock || 0);
            if (p.masterQty || p.innerQty) tooltipText += '\nEmpaque: Master: ' + (p.masterQty || 0) + ' u. | Interior: ' + (p.innerQty || 0) + ' u.';
            if (p.supplier) tooltipText += '\nProveedor: ' + p.supplier + ' (Demora: ' + (p.leadTime || 0) + ' días)';
            if (isInActiveOrder) tooltipText += '\n\n📦 REQUERIDO EN PEDIDO (Luz Azul)';

            pEl.setAttribute('data-tooltip', tooltipText);
            
            pEl.ondragstart = function(e) {
                e.dataTransfer.setData("sku", p.sku);
                const ghost = document.createElement('div');
                ghost.style.width = '60px'; ghost.style.height = '85px'; ghost.style.background = pEl.style.background;
                ghost.style.borderTop = pEl.style.borderTop; ghost.style.border = '1px solid rgba(255,255,255,0.2)';
                ghost.style.borderRadius = '4px'; ghost.style.display = 'flex'; ghost.style.flexDirection = 'column';
                ghost.style.alignItems = 'center'; ghost.style.justifyContent = 'center'; ghost.style.position = 'absolute';
                ghost.style.top = '-1000px'; ghost.style.zIndex = '10000'; ghost.innerHTML = pEl.innerHTML;
                document.body.appendChild(ghost); e.dataTransfer.setDragImage(ghost, 30, 42); setTimeout(function(){ document.body.removeChild(ghost); }, 0);
            };
            
            pEl.onclick = function() { openProductModal(p.sku); };
            
            let dotColor = 'var(--ok)';
            if(p.current < p.min) dotColor = 'var(--danger)';
            else if (p.current <= p.min * 1.2) dotColor = 'var(--warn)';
            else if (p.max > 0 && p.current > p.max) dotColor = 'var(--over)';
            
            pEl.innerHTML = '<div class="product-pos">' + posLabel + '</div><span class="stock-dot" style="background:' + dotColor + '"></span>';
            rowEl.appendChild(pEl);
        });
        wrap.appendChild(container);
    });

    const ab = document.getElementById('alertBar');
    if(alerts.length > 0) { 
        if(ab) ab.style.display = 'flex'; 
        const txt = document.getElementById('alertText');
        if(txt) txt.innerText = 'Stock crítico detectado en ' + alerts.length + ' producto(s).'; 
    } else { 
        if(ab) ab.style.display = 'none'; 
    }
}

function drop(e) {
    e.preventDefault();
    const sku = e.dataTransfer.getData("sku"); const targetRowId = e.currentTarget.id;
    const p = PRODUCTS.find(function(x) { return x.sku === sku; }); 
    const rowProds = PRODUCTS.filter(function(x) { return x.rowId === targetRowId && x.sku !== sku; });
    const used = rowProds.reduce(function(s, x) { return s + (x.widthM||0); }, 0); 
    const targetRow = ROWS.find(function(r) { return r.id === targetRowId; });

    if (used + p.widthM > targetRow.sizeM) return alert("Sin espacio en fila.");
    const rowEl = document.getElementById(targetRowId); 
    const children = Array.from(rowEl.children);
    let insertIdx = children.length;
    children.forEach(function(child, idx) { 
        const rect = child.getBoundingClientRect(); 
        if (e.clientX < (rect.left + rect.width / 2) && insertIdx === children.length) insertIdx = idx; 
    });
    rowProds.splice(insertIdx, 0, p); p.rowId = targetRowId;
    PRODUCTS = PRODUCTS.filter(function(x) { return x.rowId !== targetRowId; }).concat(rowProds); 
    sync();
    logMovement(p.sku, p.name, 0, "Cambio a fila " + targetRow.name);
}

function handleSearch(v, boxId, isDB) {
    const s = document.getElementById(boxId);
    if(!v) { s.style.display='none'; if(isDB) filterDB(''); return; }
    
    const m = PRODUCTS.filter(function(p) { 
        return (p.sku && String(p.sku).toLowerCase().includes(String(v).toLowerCase())) || 
               (p.name && String(p.name).toLowerCase().includes(String(v).toLowerCase())); 
    });
    
    s.style.display = m.length ? 'block' : 'none';
    
    let html = '';
    m.forEach(function(p) {
        html += '<div class="suggestion-item" onclick="selectSuggestion(\'' + p.sku + '\', \'' + boxId + '\', ' + isDB + ')"><b>' + p.sku + '</b> - ' + p.name + '</div>';
    });
    s.innerHTML = html;
    if(isDB) filterDB(v);
}

function selectSuggestion(sku, boxId, isDB) { 
    document.getElementById(boxId).style.display = 'none'; 
    if(isDB) {
        filterDB(sku); 
    } else { 
        currentH = sku; 
        render(); 
        if(currentViewMode === 'map') renderMap();
        const prefix = currentViewMode === 'map' ? 'map-p-' : 'p-';
        const el = document.getElementById(prefix + sku);
        if(el) el.scrollIntoView({behavior:'smooth', block:'center'}); 
    } 
}

function openProductModal(sku) {
    const sel = document.getElementById('pRowSelect'); 
    let options = '';
    ROWS.forEach(function(r) { options += '<option value="' + r.id + '">' + r.name + '</option>'; });
    sel.innerHTML = options;
    tempImg = null;
    
    if(sku && typeof sku === 'string') {
        const p = PRODUCTS.find(function(x) { return x.sku === sku; }); 
        if(!p) return;
        document.getElementById('pSku').value = p.sku; document.getElementById('pSku').disabled = true;
        document.getElementById('pName').value = p.name; document.getElementById('pWidth').value = p.widthM;
        document.getElementById('pColor').value = p.color; document.getElementById('pRowSelect').value = p.rowId;
        document.getElementById('pCurrent').value = p.current; document.getElementById('pMin').value = p.min;
        document.getElementById('pMax').value = p.max || 0; document.getElementById('pMasterQty').value = p.masterQty !== undefined ? p.masterQty : '';
        document.getElementById('pInnerQty').value = p.innerQty !== undefined ? p.innerQty : ''; document.getElementById('pSupplier').value = p.supplier || '';
        document.getElementById('pLeadTime').value = p.leadTime !== undefined ? p.leadTime : ''; 
        
        document.getElementById('pHasPO').checked = !!p.hasPO;
        document.getElementById('pReservedStock').value = p.reservedStock || 0;
        document.getElementById('pPoDate').value = p.poDate || '';
        document.getElementById('pPoArrival').value = p.poArrival || '';

        tempImg = p.photo || null; document.getElementById('pImgPreview').innerHTML = p.photo ? '<img src="' + p.photo + '">' : '<span style="font-size: 0.85rem; color:var(--muted);">Sin Imagen</span>';
        document.getElementById('btnDelProd').style.display = 'block';
    } else {
        document.getElementById('pSku').value = ''; document.getElementById('pSku').disabled = false; document.getElementById('pName').value = ''; 
        document.getElementById('pWidth').value = '0.56'; document.getElementById('pCurrent').value = '0'; document.getElementById('pMin').value = '0'; document.getElementById('pMax').value = '0';
        document.getElementById('pMasterQty').value = ''; document.getElementById('pInnerQty').value = ''; document.getElementById('pSupplier').value = '';
        document.getElementById('pLeadTime').value = ''; document.getElementById('pHasPO').checked = false; document.getElementById('pReservedStock').value = '0';
        document.getElementById('pPoDate').value = ''; document.getElementById('pPoArrival').value = '';
        document.getElementById('pImgPreview').innerHTML = '<span style="font-size: 0.85rem; color:var(--muted);">Sin Imagen</span>'; 
        document.getElementById('btnDelProd').style.display = 'none';
    }
    document.getElementById('productModal').classList.add('open');
}

function saveProduct() {
    const skuRaw = document.getElementById('pSku').value;
    const nameRaw = document.getElementById('pName').value;
    const sku = skuRaw ? skuRaw.trim() : '';
    const name = nameRaw ? nameRaw.trim() : '';

    if (!sku) return alert("Por favor, ingrese un SKU o código válido.");
    if (!name) return alert("Por favor, ingrese el nombre del producto.");

    let selectedRowId = document.getElementById('pRowSelect').value;
    if (!selectedRowId && ROWS.length > 0) selectedRowId = ROWS[0].id;

    const newStock = parseInt(document.getElementById('pCurrent').value) || 0;
    
    const data = {
        sku: sku, name: name, widthM: parseFloat(document.getElementById('pWidth').value) || 0.56,
        color: document.getElementById('pColor').value || "#c8a84b", rowId: selectedRowId,
        current: newStock, min: parseInt(document.getElementById('pMin').value) || 0, max: parseInt(document.getElementById('pMax').value) || 0,
        masterQty: parseInt(document.getElementById('pMasterQty').value) || 0, innerQty: parseInt(document.getElementById('pInnerQty').value) || 0,
        supplier: document.getElementById('pSupplier').value || "", leadTime: parseInt(document.getElementById('pLeadTime').value) || 0,
        hasPO: document.getElementById('pHasPO').checked, reservedStock: parseInt(document.getElementById('pReservedStock').value) || 0,
        poDate: document.getElementById('pPoDate').value, poArrival: document.getElementById('pPoArrival').value, photo: tempImg || null
    };

    const idx = PRODUCTS.findIndex(function(p) { return p.sku === sku; });
    
    if(idx >= 0) {
        if(PRODUCTS[idx].current !== newStock) logMovement(sku, data.name, newStock - PRODUCTS[idx].current, "Edición Manual de Producto");
        PRODUCTS[idx] = Object.assign({}, PRODUCTS[idx], data);
    } else {
        logMovement(sku, data.name, newStock, "Creación de Producto"); 
        PRODUCTS.push(data);
    }
    sync(); closeProductModalOnly();
}

function openPoModal() {
    const bActive = document.getElementById('poActiveTableBody');
    const bNew = document.getElementById('poNewTableBody');
    let activeRows = ''; let newRows = '';

    PRODUCTS.forEach(function(p) {
        const targetStock = p.max > 0 ? p.max : (p.min > 0 ? p.min * 2 : 100);
        const toOrder = targetStock > p.current ? targetStock - p.current : 0;

        if (p.hasPO) {
            let alertHTML = '<span class="status-badge" style="background:rgba(16,185,129,0.15); color:var(--ok);">Suficiente en Prov.</span>';
            if (p.reservedStock < toOrder) alertHTML = '<span class="status-badge" style="background:rgba(239,68,68,0.15); color:var(--danger);">Emitir Nueva OC</span>';
            activeRows += '<tr>' +
                '<td><b style="color:var(--text);">' + p.sku + '</b><br><small style="color:var(--muted)">' + p.name + '</small></td>' +
                '<td>' + (p.supplier || 'N/A') + '</td>' +
                '<td style="color:var(--accent); font-weight:bold; text-align:center;">' + p.current + '</td>' +
                '<td style="text-align:center;">' + (p.reservedStock || 0) + '</td>' +
                '<td style="text-align:center;"><b style="color:var(--order-blue)">' + toOrder + '</b></td>' +
                '<td>' + alertHTML + '</td></tr>';
        } else {
            if (p.current <= (p.min * 1.5)) {
                newRows += '<tr>' +
                    '<td><b style="color:var(--text);">' + p.sku + '</b><br><small style="color:var(--muted)">' + p.name + '</small></td>' +
                    '<td>' + (p.supplier || 'N/A') + '</td>' +
                    '<td style="text-align:center;">' + (p.leadTime || 0) + ' días</td>' +
                    '<td style="color:var(--danger); font-weight:bold; text-align:center; font-size:1.1rem;">' + p.current + '</td>' +
                    '<td style="text-align:center;">' + p.min + ' / ' + (p.max || 0) + '</td>' +
                    '<td style="text-align:center;"><b style="color:var(--warn); font-size:1.1rem;">' + toOrder + '</b></td>' +
                    '<td style="font-size:0.8rem; color:var(--muted);">Sol: ' + (p.poDate || '-') + '<br>Lleg: ' + (p.poArrival || '-') + '</td></tr>';
            }
        }
    });

    bActive.innerHTML = activeRows || '<tr><td colspan="6" style="text-align:center; padding: 20px; color: var(--muted);">No hay productos con contrato vigente.</td></tr>';
    bNew.innerHTML = newRows || '<tr><td colspan="7" style="text-align:center; padding: 20px; color: var(--muted);">Ningún producto urgente por solicitar.</td></tr>';
    document.getElementById('poModal').classList.add('open');
}

function openInventoryDB() { DB_CHANGES = {}; document.getElementById('sapImportSection').style.display = 'none'; document.getElementById('sapPasteInput').value = ''; document.getElementById('dbModal').classList.add('open'); filterDB(''); }

function filterDB(q) {
    const b = document.getElementById('dbTableBody'); 
    let html = '';
    PRODUCTS.filter(function(p) { return (p.sku && String(p.sku).toLowerCase().includes(String(q).toLowerCase())) || (p.name && String(p.name).toLowerCase().includes(String(q).toLowerCase())); }).forEach(function(p) {
        const row = ROWS.find(function(r) { return r.id === p.rowId; }); 
        const pIdx = PRODUCTS.filter(function(x) { return x.rowId === p.rowId; }).findIndex(function(x) { return x.sku === p.sku; }) + 1;
        const pos = row ? row.name.split(' ').pop() + pIdx : 'S/N';
        const displayStock = DB_CHANGES[p.sku] !== undefined ? DB_CHANGES[p.sku] : p.current;
        
        let rowStyle = ''; let statusLabel = '';
        if(p.current < p.min) { rowStyle = 'background: rgba(239, 68, 68, 0.05); border-left: 4px solid var(--danger);'; statusLabel = '<span class="status-badge" style="background:rgba(239,68,68,0.15); color:var(--danger);">Crítico</span>'; }
        else if (p.current <= p.min * 1.2) { rowStyle = 'background: rgba(245, 1
