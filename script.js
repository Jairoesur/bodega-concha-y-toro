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
        else if (p.current <= p.min * 1.2) { rowStyle = 'background: rgba(245, 158, 11, 0.05); border-left: 4px solid var(--warn);'; statusLabel = '<span class="status-badge" style="background:rgba(245,158,11,0.15); color:var(--warn);">Alerta</span>'; }
        else if (p.max > 0 && p.current > p.max) { rowStyle = 'background: rgba(139, 92, 246, 0.05); border-left: 4px solid var(--over);'; statusLabel = '<span class="status-badge" style="background:rgba(139,92,246,0.15); color:var(--over);">Sobre Stock</span>'; }
        else { rowStyle = 'border-left: 4px solid transparent;'; statusLabel = '<span class="status-badge" style="background:rgba(16,185,129,0.1); color:var(--ok);">Saludable</span>'; }

        html += '<tr style="' + rowStyle + '"><td><b style="color:var(--accent)">' + pos + '</b></td><td><span style="font-family:\'DM Mono\', monospace; color:var(--muted);">' + p.sku + '</span></td><td style="font-weight:500;">' + p.name + '</td><td style="text-align:center;"><input type="number" value="' + displayStock + '" oninput="DB_CHANGES[\'' + p.sku + '\'] = parseInt(this.value) || 0" style="margin:0; font-weight:bold;"></td><td>' + p.min + '</td><td>' + (p.max || 0) + '</td><td>' + statusLabel + '</td><td><button class="btn btn-secondary" style="padding:6px 12px; font-size:0.75rem;" onclick="openProductModal(\'' + p.sku + '\')">Editar</button></td></tr>';
    });
    b.innerHTML = html;
}

function applyDBChanges() {
    Object.keys(DB_CHANGES).forEach(function(sku) { 
        const pIdx = PRODUCTS.findIndex(function(x) { return x.sku === sku; }); 
        if(pIdx >= 0) {
            const newStock = parseInt(DB_CHANGES[sku]) || 0;
            if (PRODUCTS[pIdx].current !== newStock) {
                logMovement(sku, PRODUCTS[pIdx].name, newStock - PRODUCTS[pIdx].current, "Ajuste Masivo Tabla");
                PRODUCTS[pIdx].current = newStock;
            }
        } 
    });
    sync(); closeModals();
}

function openHistoryModal() {
    const b = document.getElementById('historyTableBody'); 
    let html = '';
    if(HISTORY_LOG.length === 0) { html = '<tr><td colspan="6" style="text-align:center; padding:20px; color:var(--muted);">No hay movimientos registrados.</td></tr>'; } 
    else {
        HISTORY_LOG.forEach(function(log) {
            const isPos = String(log.change).startsWith('+');
            const color = isPos ? 'var(--ok)' : 'var(--danger)';
            html += '<tr><td style="color:var(--muted); font-size:0.8rem;">' + log.date + '</td><td><span style="font-family:\'DM Mono\', monospace; color:var(--accent);">' + log.sku + '</span></td><td style="font-weight:500;">' + log.name + '</td><td><b style="color:' + color + '; font-size:1.1rem;">' + log.change + '</b></td><td style="font-size:0.8rem; color:var(--muted);">' + log.user + '</td><td style="color:var(--text);"><i>' + log.reason + '</i></td></tr>';
        });
    }
    b.innerHTML = html;
    document.getElementById('historyModal').classList.add('open');
}

function toggleSapSection() { const section = document.getElementById('sapImportSection'); section.style.display = section.style.display === 'none' ? 'block' : 'none'; }

function processSapPaste() {
    const inputData = document.getElementById('sapPasteInput').value.trim(); 
    if (!inputData) return alert("El cuadro de texto está vacío.");
    const lines = inputData.split('\n'); let updatedCount = 0; let createdCount = 0;
    
    lines.forEach(function(line) {
        const delimiter = line.includes('\t') ? '\t' : (line.includes(';') ? ';' : ',');
        const cols = line.split(delimiter);
        
        if (cols.length >= 2) {
            const sku = cols[0] ? cols[0].trim() : ''; if (!sku) return; 
            const name = cols[1] ? cols[1].trim() : "Vino Importado";
            const qtyStr = cols[2] ? cols[2].trim() : ''; const qty = qtyStr ? parseInt(qtyStr) : 0;
            const pIdx = PRODUCTS.findIndex(function(p) { return p.sku && p.sku.toLowerCase() === sku.toLowerCase(); });
            
            if (pIdx >= 0) {
                if (!isNaN(qty) && qtyStr !== "" && PRODUCTS[pIdx].current !== qty) { logMovement(sku, name, qty - PRODUCTS[pIdx].current, "Importación SAP"); PRODUCTS[pIdx].current = qty; updatedCount++; }
                if (cols[1] && cols[1].trim() !== '') PRODUCTS[pIdx].name = cols[1].trim();
                if (cols[3] && cols[3].trim() !== '') {
                    const rowSearch = cols[3].trim().toLowerCase();
                    const matchedRow = ROWS.find(function(r) { return r.name.toLowerCase() === rowSearch || r.id.toLowerCase() === rowSearch; });
                    if (matchedRow) PRODUCTS[pIdx].rowId = matchedRow.id;
                }
                if (cols[4] && cols[4].trim() !== '') PRODUCTS[pIdx].masterQty = parseInt(cols[4].trim());
                if (cols[5] && cols[5].trim() !== '') PRODUCTS[pIdx].innerQty = parseInt(cols[5].trim());
                if (cols[6] && cols[6].trim() !== '') PRODUCTS[pIdx].min = parseInt(cols[6].trim());
                if (cols[7] && cols[7].trim() !== '') PRODUCTS[pIdx].max = parseInt(cols[7].trim());
                if (cols[8] && cols[8].trim() !== '') PRODUCTS[pIdx].supplier = cols[8].trim();
                if (cols[9] && cols[9].trim() !== '') PRODUCTS[pIdx].leadTime = parseInt(cols[9].trim());
            } else {
                let targetRowId = ROWS.length > 0 ? ROWS[0].id : ''; 
                if (cols[3] && cols[3].trim() !== '') {
                    const rowSearch = cols[3].trim().toLowerCase();
                    const matchedRow = ROWS.find(function(r) { return r.name.toLowerCase() === rowSearch || r.id.toLowerCase() === rowSearch; });
                    if (matchedRow) targetRowId = matchedRow.id;
                }
                const newProd = { 
                    sku: sku, name: name, widthM: 0.56, color: "#c8a84b", rowId: targetRowId, current: isNaN(qty) ? 0 : qty, 
                    masterQty: parseInt(cols[4] ? cols[4].trim() : '') || 0, innerQty: parseInt(cols[5] ? cols[5].trim() : '') || 0, 
                    min: parseInt(cols[6] ? cols[6].trim() : '') || 0, max: parseInt(cols[7] ? cols[7].trim() : '') || 0, 
                    supplier: cols[8] ? cols[8].trim() : "", leadTime: parseInt(cols[9] ? cols[9].trim() : '') || 0,
                    hasPO: false, reservedStock: 0, photo: null 
                };
                PRODUCTS.push(newProd); logMovement(sku, name, newProd.current, "Alta desde SAP"); createdCount++;
            }
        }
    });
    alert("Proceso finalizado.\nActualizados: " + updatedCount + "\nCreados: " + createdCount); 
    sync(); filterDB('');
}

function openOrderModal() {
    document.getElementById('orderModal').classList.add('open');
    if (ACTIVE_ORDER.length > 0) {
        document.getElementById('orderLoadSection').style.display = 'none';
        document.getElementById('orderPrepSection').style.display = 'flex';
        renderOrderPrepTable();
    } else {
        document.getElementById('orderLoadSection').style.display = 'block';
        document.getElementById('orderPrepSection').style.display = 'none';
        document.getElementById('orderPasteInput').value = '';
    }
}

function processOrderPaste() {
    const inputData = document.getElementById('orderPasteInput').value.trim();
    if (!inputData) return alert("Por favor, pegue los datos.");
    const lines = inputData.split('\n'); ACTIVE_ORDER = [];
    
    lines.forEach(function(line) {
        const delimiter = line.includes('\t') ? '\t' : (line.includes(';') ? ';' : ',');
        const columns = line.split(delimiter);
        if (columns.length >= 2) {
            const sku = columns[0] ? columns[0].trim() : '';
            const qtyStr = columns[columns.length - 1] ? columns[columns.length - 1].trim() : '';
            const requestedQty = parseInt(qtyStr) || 0;
            const pastedName = columns[1] ? columns[1].trim() : "Producto Tienda";
            if (sku && requestedQty > 0) ACTIVE_ORDER.push({ sku: sku, name: pastedName, requested: requestedQty, picked: requestedQty, completed: false });
        }
    });

    if (ACTIVE_ORDER.length > 0) {
        document.getElementById('orderLoadSection').style.display = 'none';
        document.getElementById('orderPrepSection').style.display = 'flex';
        renderOrderPrepTable(); sync(); alert("¡Pedido cargado! " + ACTIVE_ORDER.length + " productos resaltados en azul en los racks.");
    }
}

function renderOrderPrepTable() {
    const tbody = document.getElementById('orderTableBody'); let html = '';
    ACTIVE_ORDER.forEach(function(item, index) {
        const p = PRODUCTS.find(function(x) { return x.sku && x.sku.toLowerCase() === item.sku.toLowerCase(); });
        let locationLabel = "<span style='color:var(--danger); font-weight:600;'>⚠️ No está en racks</span>";
        if (p) {
            const row = ROWS.find(function(r) { return r.id === p.rowId; });
            const pIdx = PRODUCTS.filter(function(x) { return x.rowId === p.rowId; }).findIndex(function(x) { return x.sku === p.sku; }) + 1;
            locationLabel = row ? '<b style="color:var(--accent)">' + row.name + ' (Pos. ' + pIdx + ')</b>' : 'S/N';
        }
        const rowStyle = item.completed ? 'opacity: 0.35; background: rgba(0,0,0,0.4);' : '';
        const textStyle = item.completed ? 'text-decoration: line-through;' : '';
        
        html += '<tr style="' + rowStyle + '">' +
            '<td style="text-align:center;"><input type="checkbox" ' + (item.completed ? 'checked' : '') + ' onchange="toggleOrderItem(' + index + ')"></td>' +
            '<td style="' + textStyle + '">' + locationLabel + '</td>' +
            '<td style="' + textStyle + '"><span style="font-family:\'DM Mono\', monospace; color:var(--muted);">' + item.sku + '</span></td>' +
            '<td style="' + textStyle + ' font-weight:500;">' + (p ? p.name : item.name) + '</td>' +
            '<td style="' + textStyle + ' text-align:center;"><b style="font-size:1.1rem; color:var(--accent);">' + item.requested + '</b></td>' +
            '<td style="text-align:center;"><input type="number" value="' + item.picked + '" style="width:90px; text-align:center; background:var(--bg); border:1px solid var(--border); color:#fff; padding:6px; border-radius:4px; margin:0;" oninput="updateOrderPickedQty(' + index + ', this.value)" ' + (item.completed ? 'disabled' : '') + '></td>' +
        '</tr>';
    });
    tbody.innerHTML = html;
}

function toggleOrderItem(index) { 
    ACTIVE_ORDER[index].completed = !ACTIVE_ORDER[index].completed; 
    renderOrderPrepTable(); 
    render(); 
    if(currentViewMode === 'map') renderMap();
}

function updateOrderPickedQty(index, value) { ACTIVE_ORDER[index].picked = parseInt(value) || 0; }
function cancelActiveOrder() { if (confirm("¿Vaciar pedido y quitar alertas azules en bodega?")) { ACTIVE_ORDER = []; sync(); closeModals(); } }

function finalizeOrder() {
    let countDespachados = 0;
    ACTIVE_ORDER.forEach(function(item) {
        const pIdx = PRODUCTS.findIndex(function(x) { return x.sku && x.sku.toLowerCase() === item.sku.toLowerCase(); });
        if (pIdx >= 0) {
            const oldStock = PRODUCTS[pIdx].current;
            PRODUCTS[pIdx].current -= item.picked;
            if (PRODUCTS[pIdx].current < 0) PRODUCTS[pIdx].current = 0; 
            const descontado = oldStock - PRODUCTS[pIdx].current;
            if(descontado > 0) { logMovement(PRODUCTS[pIdx].sku, PRODUCTS[pIdx].name, -descontado, "Despacho Pedido (Solicitado: " + item.requested + ")"); countDespachados++; }
        }
    });
    alert("¡Inventario Descontado! Se actualizó el stock de " + countDespachados + " productos.");
    ACTIVE_ORDER = []; sync(); closeModals();
}

function deleteProduct() { if(confirm("¿Seguro de eliminar producto?")) { const sku = document.getElementById('pSku').value; logMovement(sku, document.getElementById('pName').value, -document.getElementById('pCurrent').value, "Eliminado del Sistema"); PRODUCTS = PRODUCTS.filter(function(p) { return p.sku !== sku; }); sync(); closeProductModalOnly(); } }

function openRowModal(id) { 
    const r = (id && typeof id === 'string') ? ROWS.find(function(x) { return x.id === id; }) : {id:'', name:'', sizeM:15, shape:'straight'}; 
    document.getElementById('rId').value = r.id; 
    document.getElementById('rName').value = r.name; 
    document.getElementById('rSize').value = r.sizeM; 
    
    // Asignación Forma Estructural
    const shapeSelect = document.getElementById('rShape');
    if(shapeSelect) shapeSelect.value = r.shape || 'straight';

    document.getElementById('btnDelRow').style.display = id ? 'block' : 'none'; 
    document.getElementById('rowModal').classList.add('open'); 
}

function saveRow() { 
    const id = document.getElementById('rId').value; 
    const shapeSelect = document.getElementById('rShape');
    const data = { 
        id: id || 'R'+Date.now(), 
        name: document.getElementById('rName').value, 
        sizeM: parseFloat(document.getElementById('rSize').value) || 15,
        shape: shapeSelect ? shapeSelect.value : 'straight'
    }; 
    
    const idx = ROWS.findIndex(function(x) { return x.id===id; });
    if(idx >= 0) {
        // Preservar datos espaciales (mapa 2D) si ya existe
        data.whId = ROWS[idx].whId;
        data.x = ROWS[idx].x;
        data.y = ROWS[idx].y;
        data.rotation = ROWS[idx].rotation;
        ROWS[idx] = data;
    } else {
        ROWS.push(data); 
    }
    sync(); closeModals(); 
}

function deleteRow() { const id = document.getElementById('rId').value; if(PRODUCTS.some(function(p) { return p.rowId === id; })) return alert("Fila con productos. Mueve los productos antes."); if(confirm("¿Eliminar fila?")) { ROWS = ROWS.filter(function(r) { return r.id !== id; }); sync(); closeModals(); } }
function processImage(input) { if (input.files && input.files[0]) { const reader = new FileReader(); reader.onload = function(e) { const img = new Image(); img.onload = function() { const canvas = document.createElement('canvas'); const scale = 300 / img.width; canvas.width = 300; canvas.height = img.height * scale; canvas.getContext('2d').drawImage(img, 0,0,300, canvas.height); tempImg = canvas.toDataURL('image/jpeg', 0.6); document.getElementById('pImgPreview').innerHTML = '<img src="' + tempImg + '" style="max-height:160px; border-radius:4px;">'; }; img.src = e.target.result; }; reader.readAsDataURL(input.files[0]); } }
function closeModals() { document.querySelectorAll('.modal').forEach(function(m) { m.classList.remove('open'); }); }
function closeProductModalOnly() { document.getElementById('productModal').classList.remove('open'); }

/* ─── ROBOT DE CORREOS AUTOMÁTICOS ─── */
const EMAILJS_PUBLIC_KEY = "cdusqn38kGYK4HyVj"; 
const EMAILJS_SERVICE_ID = "service_00sszf8"; 
const EMAILJS_TEMPLATE_ID = "template_1n41bpp"; 
const CORREOS_DESTINATARIOS = [ "bodegavct@gmail.com", "nestor.mellado@vctchile.com", "jairo.escobedo@vctchile.com" ];
if(typeof emailjs !== 'undefined') emailjs.init(EMAILJS_PUBLIC_KEY);

function verificarYEnviarReporteDiario() {
    const ahora = new Date(); const hoyStr = ahora.toISOString().split('T')[0];
    const horaActual = ahora.getHours(); const minutoActual = ahora.getMinutes();
    
    if (horaActual >= 8) {
        const ultimoEnvio = localStorage.getItem('ultimoReporteStock');
        if (ultimoEnvio !== hoyStr) {
            const criticos = PRODUCTS.filter(function(p) { return p && p.current < p.min; });
            if (criticos.length === 0) { localStorage.setItem('ultimoReporteStock', hoyStr); return; }

            let filas = "";
            criticos.forEach(function(p) { 
                filas += '<tr><td style="padding:14px; border-bottom:1px solid #38352f; color:#d4af37; font-weight:bold;">' + p.sku + '</td><td style="padding:14px; border-bottom:1px solid #38352f; color:#f0ede6;">' + p.name + '</td><td style="padding:14px; border-bottom:1px solid #38352f; color:#ef4444; text-align:center; font-weight:bold;">' + p.current + '</td><td style="padding:14px; border-bottom:1px solid #38352f; color:#a39c93; text-align:center;">' + p.min + '</td></tr>'; 
            });

            const htmlContent = '<div style="background:#0d0c0b; color:#f0ede6; font-family:sans-serif; padding:45px; max-width:650px; margin:auto; border:1px solid #38352f; border-radius:16px;"><h2 style="color:#d4af37; border-bottom:1px solid #38352f; padding-bottom:15px; text-transform:uppercase; letter-spacing:1px; margin-top:0;">Alerta de Reposición — Concha y Toro</h2><p style="color:#a39c93; font-size:15px;">Reporte automático diario de productos bajo el stock mínimo:</p><table style="width:100%; border-collapse:collapse; margin-top:25px;"><thead><tr style="background:#1a1916; color:#a39c93; font-size:13px; text-transform:uppercase; letter-spacing:0.5px;"><th style="padding:14px; text-align:left; border-bottom:2px solid #38352f;">SKU</th><th style="padding:14px; text-align:left; border-bottom:2px solid #38352f;">Producto</th><th style="padding:14px; text-align:center; border-bottom:2px solid #38352f;">Stock</th><th style="padding:14px; text-align:center; border-bottom:2px solid #38352f;">Mín.</th></tr></thead><tbody style="font-size:14px;">' + filas + '</tbody></table></div>';

            if(typeof emailjs !== 'undefined') {
                CORREOS_DESTINATARIOS.forEach(function(correo) {
                    emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, { tablaHTML: htmlContent, to_email: correo })
                    .catch(function(err) { console.error("Error al enviar a " + correo + ":", err); });
                });
            }
            localStorage.setItem('ultimoReporteStock', hoyStr);
        }
    }
}

/* ===============================================================
   VISTA AÉREA INTERACTIVA (MAPA 2D) - ROTACIÓN Y FORMAS
   =============================================================== */
let draggingMapItem = null;
let dragOffsetX = 0;
let dragOffsetY = 0;

function toggleViewMode() {
    const whWrap = document.getElementById('whWrap');
    const mapWrap = document.getElementById('mapWrap');
    const btn = document.getElementById('btnToggleView');
    
    if (currentViewMode === 'racks') {
        currentViewMode = 'map';
        whWrap.style.display = 'none';
        mapWrap.style.display = 'flex';
        btn.innerText = "📄 Vista Racks Clásica";
        btn.style.background = "var(--accent)";
        btn.style.color = "#000";
        renderMap();
    } else {
        currentViewMode = 'racks';
        mapWrap.style.display = 'none';
        whWrap.style.display = 'flex'; 
        btn.innerText = "📍 Vista Aérea 2D";
        btn.style.background = "transparent";
        btn.style.color = "var(--accent)";
    }
}

function changeActiveWarehouse(whId) { activeWarehouseId = whId; renderMap(); }

function renderMap() {
    if (currentViewMode !== 'map') return;
    
    const sel = document.getElementById('mapBodegaSelect');
    let selHtml = '';
    WAREHOUSES.forEach(function(w) { selHtml += '<option value="' + w.id + '" ' + (w.id === activeWarehouseId ? 'selected' : '') + '>' + w.name + '</option>'; });
    sel.innerHTML = selHtml;

    const activeWH = WAREHOUSES.find(function(w) { return w.id === activeWarehouseId; }) || WAREHOUSES[0];
    if (!activeWH) return;

    const scale = activeWH.scale || 25;
    const canvas = document.getElementById('mapCanvas');
    
    canvas.style.width = (activeWH.widthM * scale) + 'px';
    canvas.style.height = (activeWH.lengthM * scale) + 'px';
    canvas.innerHTML = ''; 

    // Renderizar Zonas / Pasillos
    const whZones = ZONES.filter(function(z) { return z.whId === activeWH.id; });
    whZones.forEach(function(zone) {
        const zEl = document.createElement('div');
        zEl.className = 'map-entity-zone';
        zEl.id = 'map-zone-' + zone.id;
        zEl.style.width = (zone.widthM * scale) + 'px';
        zEl.style.height = (zone.lengthM * scale) + 'px';
        zEl.style.left = (zone.x * scale) + 'px';
        zEl.style.top = (zone.y * scale) + 'px';
        
        // Rotación de Pasillo
        zEl.style.transform = 'rotate(' + (zone.rotation || 0) + 'deg)';
        zEl.innerHTML = '<span>' + zone.name + '</span>';
        
        // Tirador de Rotación Libre
        const rotHandle = document.createElement('div');
        rotHandle.className = 'rotator-handle';
        rotHandle.innerHTML = '<div class="rotator-line"></div>';
        rotHandle.onmousedown = function(e) { initRotate(e, 'zone', zone.id); };
        zEl.appendChild(rotHandle);

        zEl.onmousedown = function(e) { initMapDrag(e, 'zone', zone.id); };
        zEl.ondblclick = function(e) { e.stopPropagation(); openZoneModal(zone.id); }; 
        canvas.appendChild(zEl);
    });

    const assignedRows = [];
    const unassignedRows = [];
    
    ROWS.forEach(function(r) {
        if (r.whId === activeWH.id) assignedRows.push(r);
        else if (!r.whId) unassignedRows.push(r);
    });

    // Renderizar Filas / Racks
    assignedRows.forEach(function(row) {
        const rEl = document.createElement('div');
        
        // Asignación dinámica de Clases de Forma (Curva, L, U)
        let shapeClass = '';
        if(row.shape === 'curve-soft') shapeClass = ' shape-curve-soft';
        else if(row.shape === 'curve-hard') shapeClass = ' shape-curve-hard';
        else if(row.shape === 'L') shapeClass = ' shape-L';
        else if(row.shape === 'U') shapeClass = ' shape-U';
        
        rEl.className = 'map-entity-row' + shapeClass;
        rEl.id = 'map-row-' + row.id;
        
        const rWidthPx = row.sizeM * scale;
        const rDepthPx = 1.2 * scale; // Fondo estándar (1.2m)
        
        rEl.style.width = rWidthPx + 'px';
        rEl.style.height = rDepthPx + 'px';
        
        // Dependiendo de la forma (L, C), ajustamos las dimensiones para que el contenedor permita el quiebre de los productos internos
        if(row.shape === 'L' || row.shape === 'U') {
            rEl.style.height = (rWidthPx * 0.5) + 'px'; // Se hace más cuadrado para permitir el pliegue L o U
        }

        rEl.style.left = (row.x * scale) + 'px';
        rEl.style.top = (row.y * scale) + 'px';
        
        // Rotación Angular de Fila
        rEl.style.transform = 'rotate(' + (row.rotation || 0) + 'deg)';

        // Tirador de Rotación Libre
        const rotHandle = document.createElement('div');
        rotHandle.className = 'rotator-handle';
        rotHandle.innerHTML = '<div class="rotator-line"></div>';
        rotHandle.onmousedown = function(e) { initRotate(e, 'row', row.id); };
        rEl.appendChild(rotHandle);

        const lbl = document.createElement('div');
        lbl.className = 'map-entity-row-label';
        lbl.innerText = row.name;
        rEl.appendChild(lbl);

        const rowProds = PRODUCTS.filter(function(p) { return p && p.rowId === row.id; });
        rowProds.forEach(function(p) {
            const pWidthPx = p.widthM * scale;
            const pEl = document.createElement('div');
            
            // Re-evaluar orden para Tooltips aéreos y Color de Iluminación
            const isInActiveOrder = ACTIVE_ORDER.some(function(item) { return item.sku.toLowerCase() === p.sku.toLowerCase() && !item.completed; });
            
            pEl.className = 'map-mini-product';
            if (isInActiveOrder) pEl.className += ' is-ordered';
            
            pEl.style.background = p.color || '#c8a84b';
            pEl.style.width = pWidthPx + 'px';

            if (currentH === p.sku) { pEl.style.boxShadow = '0 0 0 2px var(--bg), 0 0 10px var(--accent)'; pEl.style.zIndex = 10; }

            let tooltipText = 'SKU: ' + p.sku + '\nProducto: ' + p.name + '\nStock Físico: ' + p.current;
            pEl.setAttribute('data-tooltip', tooltipText);
            
            pEl.onmousedown = function(e) { e.stopPropagation(); }; 
            pEl.onclick = function() { openProductModal(p.sku); };
            
            rEl.appendChild(pEl);
        });

        rEl.onmousedown = function(e) { initMapDrag(e, 'row', row.id); };
        
        // Shift + Doble Clic saca la fila del plano. 
        rEl.ondblclick = function(e) {
            if (e.shiftKey) { row.whId = null; row.x = 0; row.y = 0; row.rotation = 0; sync(); } 
        };

        canvas.appendChild(rEl);
    });

    const unassignWrap = document.getElementById('mapUnassignedRows');
    let uHtml = '';
    if (unassignedRows.length === 0) {
        uHtml = '<p style="color:var(--ok); font-size:0.8rem; text-align:center;">Todas las filas están ubicadas.</p>';
    } else {
        unassignedRows.forEach(function(ur) {
            uHtml += '<div class="unassigned-row-card"><b>' + ur.name + '</b><button class="btn btn-secondary" style="padding:4px 8px; font-size:0.7rem;" onclick="assignRowToMap(\'' + ur.id + '\')">Al Plano ➡️</button></div>';
        });
    }
    unassignWrap.innerHTML = uHtml;
}

// ─── FUNCIONES DE ROTACIÓN Y DRAG DEDICADAS ───
function initRotate(e, type, id) {
    e.stopPropagation();
    e.preventDefault();
    
    const el = document.getElementById('map-' + type + '-' + id);
    if(!el) return;
    
    const rect = el.getBoundingClientRect();
    const centerX = rect.left + (rect.width / 2);
    const centerY = rect.top + (rect.height / 2);

    function onRotateDrag(ev) {
        // Cálculo del ángulo según la posición del cursor respecto al centro de la figura
        const dx = ev.clientX - centerX;
        const dy = ev.clientY - centerY;
        let angle = Math.atan2(dy, dx) * (180 / Math.PI);
        angle += 90; // Compensación debido a que el handle está arriba (Top)
        
        // Suavizado en giros estándar
        angle = Math.round(angle);
        if (angle < 0) angle += 360;

        el.style.transform = 'rotate(' + angle + 'deg)';
        
        // Almacenar rotación en variable temporal
        if(type === 'row') {
            const r = ROWS.find(function(x) { return x.id === id; });
            if(r) r.rotation = angle;
        } else {
            const z = ZONES.find(function(x) { return x.id === id; });
            if(z) z.rotation = angle;
        }
    }

    function onRotateDrop() {
        document.removeEventListener('mousemove', onRotateDrag);
        document.removeEventListener('mouseup', onRotateDrop);
        sync(); // Guardar ángulo en Firebase
    }

    document.addEventListener('mousemove', onRotateDrag);
    document.addEventListener('mouseup', onRotateDrop);
}

function assignRowToMap(rowId) {
    const row = ROWS.find(function(r) { return r.id === rowId; });
    if(row && activeWarehouseId) {
        row.whId = activeWarehouseId;
        row.x = 0; row.y = 0; row.rotation = 0;
        sync();
    }
}

function initMapDrag(e, type, id) {
    if (e.button !== 0) return; 
    e.stopPropagation();
    
    const el = document.getElementById('map-' + type + '-' + id);
    if(e.target.classList.contains('rotator-handle')) return; // No arrastrar si presiona el rotador
    
    draggingMapItem = { type: type, id: id };
    
    const rect = el.getBoundingClientRect();
    dragOffsetX = e.clientX - rect.left;
    dragOffsetY = e.clientY - rect.top;

    document.addEventListener('mousemove', onMapDrag);
    document.addEventListener('mouseup', onMapDrop);
}

function onMapDrag(e) {
    if(!draggingMapItem) return;
    const canvas = document.getElementById('mapCanvas');
    const canvasRect = canvas.getBoundingClientRect();
    
    let x = e.clientX - canvasRect.left - dragOffsetX;
    let y = e.clientY - canvasRect.top - dragOffsetY;

    const el = document.getElementById('map-' + draggingMapItem.type + '-' + draggingMapItem.id);
    if(el) { el.style.left = x + 'px'; el.style.top = y + 'px'; }
}

function onMapDrop(e) {
    document.removeEventListener('mousemove', onMapDrag);
    document.removeEventListener('mouseup', onMapDrop);
    if(!draggingMapItem) return;

    const canvas = document.getElementById('mapCanvas');
    const canvasRect = canvas.getBoundingClientRect();
    const activeWH = WAREHOUSES.find(function(w) { return w.id === activeWarehouseId; });
    const scale = activeWH ? (activeWH.scale || 25) : 25;

    let x = e.clientX - canvasRect.left - dragOffsetX;
    let y = e.clientY - canvasRect.top - dragOffsetY;

    let xM = Math.max(0, parseFloat((x / scale).toFixed(2)));
    let yM = Math.max(0, parseFloat((y / scale).toFixed(2)));

    if(draggingMapItem.type === 'row') {
        const row = ROWS.find(function(r) { return r.id === draggingMapItem.id; });
        if(row) { row.x = xM; row.y = yM; }
    } else if (draggingMapItem.type === 'zone') {
        const zone = ZONES.find(function(z) { return z.id === draggingMapItem.id; });
        if(zone) { zone.x = xM; zone.y = yM; }
    }

    draggingMapItem = null;
    sync(); 
}

// ─── MODALES DE CONFIGURACIÓN BODEGA Y ZONAS ───
function openWarehouseModal(id) {
    const wh = (id && typeof id === 'string') ? WAREHOUSES.find(function(x) { return x.id === id; }) : null;
    if(wh) {
        document.getElementById('whId').value = wh.id;
        document.getElementById('whName').value = wh.name;
        document.getElementById('whWidth').value = wh.widthM;
        document.getElementById('whLength').value = wh.lengthM;
        document.getElementById('whScale').value = wh.scale || 25;
        document.getElementById('btnDelWh').style.display = 'block';
        document.getElementById('whModalTitle').innerText = "Editar Bodega";
    } else {
        document.getElementById('whId').value = '';
        document.getElementById('whName').value = '';
        document.getElementById('whWidth').value = '';
        document.getElementById('whLength').value = '';
        document.getElementById('whScale').value = 25;
        document.getElementById('btnDelWh').style.display = 'none';
        document.getElementById('whModalTitle').innerText = "Nueva Bodega";
    }
    document.getElementById('warehouseModal').classList.add('open');
}

function saveWarehouse() {
    const id = document.getElementById('whId').value || 'WH' + Date.now();
    const name = document.getElementById('whName').value.trim();
    const widthM = parseFloat(document.getElementById('whWidth').value) || 30;
    const lengthM = parseFloat(document.getElementById('whLength').value) || 20;
    const scale = parseFloat(document.getElementById('whScale').value) || 25;

    if(!name) return alert("El nombre es requerido.");

    const data = { id: id, name: name, widthM: widthM, lengthM: lengthM, scale: scale };
    const idx = WAREHOUSES.findIndex(function(x) { return x.id === id; });
    
    if(idx >= 0) WAREHOUSES[idx] = data;
    else WAREHOUSES.push(data);
    
    activeWarehouseId = id;
    sync(); closeModals();
}

function deleteWarehouse() {
    const id = document.getElementById('whId').value;
    if(ROWS.some(function(r) { return r.whId === id; })) return alert("Saca todas las filas de esta bodega antes de eliminarla (Shift + Doble Clic).");
    if(confirm("¿Eliminar Bodega? Se perderán sus pasillos (Las filas irán a 'Por asignar').")) {
        WAREHOUSES = WAREHOUSES.filter(function(w) { return w.id !== id; });
        ZONES = ZONES.filter(function(z) { return z.whId !== id; });
        activeWarehouseId = WAREHOUSES.length ? WAREHOUSES[0].id : null;
        sync(); closeModals();
    }
}

function openZoneModal(id) {
    if(!activeWarehouseId) return alert("Selecciona o crea una bodega primero.");
    const z = (id && typeof id === 'string') ? ZONES.find(function(x) { return x.id === id; }) : null;
    if(z) {
        document.getElementById('zId').value = z.id;
        document.getElementById('zName').value = z.name;
        document.getElementById('zWidth').value = z.widthM;
        document.getElementById('zLength').value = z.lengthM;
        document.getElementById('btnDelZone').style.display = 'block';
    } else {
        document.getElementById('zId').value = '';
        document.getElementById('zName').value = '';
        document.getElementById('zWidth').value = 4;
        document.getElementById('zLength').value = 10;
        document.getElementById('btnDelZone').style.display = 'none';
    }
    document.getElementById('zoneModal').classList.add('open');
}

function saveZone() {
    const id = document.getElementById('zId').value || 'Z' + Date.now();
    const data = { 
        id: id, whId: activeWarehouseId, 
        name: document.getElementById('zName').value || 'Pasillo', 
        widthM: parseFloat(document.getElementById('zWidth').value) || 2, 
        lengthM: parseFloat(document.getElementById('zLength').value) || 10,
        x: 0, y: 0, rotation: 0
    };
    
    const exist = ZONES.find(function(x) { return x.id === id; });
    if(exist) { data.x = exist.x; data.y = exist.y; data.rotation = exist.rotation; }

    const idx = ZONES.findIndex(function(x) { return x.id === id; });
    if(idx >= 0) ZONES[idx] = data;
    else ZONES.push(data);
    
    sync(); closeModals();
}

function deleteZone() {
    const id = document.getElementById('zId').value;
    if(confirm("¿Eliminar pasillo/zona?")) {
        ZONES = ZONES.filter(function(z) { return z.id !== id; });
        sync(); closeModals();
    }
}
