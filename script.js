// CERROJO DE SESIÓN ABSOLUTO: Evita doble ejecución de código.
if (window.WMS_INITIALIZED) {
    console.warn("WMS: Bloqueando ejecución duplicada del script.");
} else {
    window.WMS_INITIALIZED = true;

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

    let ROWS = [];
    let RACKS = []; 
    let PRODUCTS = [];
    let HISTORY_LOG = []; 
    let ACTIVE_ORDER = [];
    let tempImg = null, currentH = null;
    let DB_CHANGES = {};

    let WAREHOUSES = [];
    let ZONES = [];
    let currentViewMode = 'racks';
    let activeWarehouseId = null;

    let selectedMapItem = null;
    let draggingMapItem = null;
    let dragOffsetX = 0, dragOffsetY = 0;

    let gsheetsConfig = { sheetId: '', tabName: 'Productos', lastSync: '' };

    // DRAG NATIVO PERMITIENDO SCROLL DEL MOUSE
    document.addEventListener("dragover", function(e) {
        e.preventDefault(); 
        const edge = 80;
        const speed = 20;
        if (e.clientY > window.innerHeight - edge) window.scrollBy(0, speed);
        else if (e.clientY < edge) window.scrollBy(0, -speed);
    });

    // MOTOR TOOLTIP INTELIGENTE GLOBAL
    let globalTooltip = document.getElementById('global-tooltip');
    if(!globalTooltip) {
        globalTooltip = document.createElement('div');
        globalTooltip.id = 'global-tooltip';
        document.body.appendChild(globalTooltip);
    }

    document.addEventListener('mousemove', function(e) {
        const p = e.target.closest('.product, .map-mini-product');
        if(p) {
            const text = p.getAttribute('data-tooltip');
            if(text) {
                globalTooltip.innerText = text;
                globalTooltip.classList.add('show');
                
                const rect = p.getBoundingClientRect();
                let left = rect.left + (rect.width / 2);
                let top = rect.top - 10;
                
                let transformY = '-100%';
                if (top - globalTooltip.offsetHeight < 0) {
                    top = rect.bottom + 10; 
                    transformY = '0';
                }
                
                let transformX = '-50%';
                if (left - (globalTooltip.offsetWidth / 2) < 10) {
                    left = 10;
                    transformX = '0';
                } else if (left + (globalTooltip.offsetWidth / 2) > window.innerWidth - 10) {
                    left = window.innerWidth - 10;
                    transformX = '-100%';
                }

                globalTooltip.style.transform = `translate(${transformX}, ${transformY})`;
                globalTooltip.style.left = left + 'px';
                globalTooltip.style.top = top + 'px';
            }
        } else {
            globalTooltip.classList.remove('show');
        }
    });

    function handleLogin(e) {
        if(e && e.preventDefault) e.preventDefault();
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

    function sanitizeRackStructure(rack) {
        if (!rack) return;
        if (!rack.cols) rack.cols = [];
        if (!Array.isArray(rack.cols)) rack.cols = Object.values(rack.cols);
        
        rack.cols.forEach((col, c) => {
            if (!col) { rack.cols[c] = { levels: [] }; col = rack.cols[c]; }
            if (!col.levels) col.levels = [];
            else if (typeof col.levels === 'number') {
                let count = col.levels;
                col.levels = [];
                for(let i=0; i<count; i++) col.levels.push({cap:10, w:1.2, h:1.0});
            } 
            else if (!Array.isArray(col.levels)) {
                col.levels = Object.values(col.levels);
            }
            
            col.levels.forEach(lvl => {
                if(lvl.w === undefined) lvl.w = 1.2;
                if(lvl.h === undefined) lvl.h = 1.0;
                if(lvl.cap === undefined) lvl.cap = 10;
            });
        });
    }

    // CORRECCIÓN EXACTA: Filtro de sanitización segura para Firebase (Evita excepciones de lectura)
    function safeStr(val) {
        if (val === null || val === undefined) return '';
        return String(val).trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    }

    // RESOLUTOR INTELIGENTE DE UBICACIONES (Blindado contra fallos de objetos indefinidos y valores nulos)
    function findLocationId(locStr) {
        if (!locStr) return '';
        const locClean = safeStr(locStr);
        if (locClean === '') return '';

        try {
            // 1. Coincidencia directa con Filas
            const matchedRow = ROWS.find(r => r && (safeStr(r.id) === locClean || safeStr(r.name) === locClean));
            if (matchedRow) return matchedRow.id;

            // 2. Coincidencia con Racks (Formato RK-123-C0-L1)
            if (locClean.startsWith('rk-')) {
                const parts = locClean.split('-'); 
                if (parts.length >= 4) {
                    const rackPart = parts[1]; 
                    const matchedRack = RACKS.find(r => r && (
                        safeStr(r.id) === rackPart || 
                        safeStr(r.identifier) === rackPart ||
                        safeStr(r.name) === rackPart
                    ));
                    if (matchedRack) {
                        return `RK-${matchedRack.id}-${parts[2].toUpperCase()}-${parts[3].toUpperCase()}`;
                    }
                }
            }

            // 3. Nomenclatura Humana de Racks (Rack Principal - C1-N2)
            const colMatch = locStr.match(/C(\d+)/i);
            const lvlMatch = locStr.match(/[LN](\d+)/i); 
            
            if (colMatch && lvlMatch) {
                const colIdx = parseInt(colMatch[1]) - 1; 
                const lvlIdx = parseInt(lvlMatch[1]) - 1; 

                const rackCleanName = safeStr(locStr.replace(/[-_()]/g, ' ').replace(/C\d+/i, '').replace(/[LN]\d+/i, ''));

                const matchedRack = RACKS.find(r => {
                    if (!r) return false;
                    const rNameNorm = safeStr(r.name);
                    const rIdenNorm = safeStr(r.identifier);
                    const rIdNorm = safeStr(r.id);
                    
                    return (rNameNorm && rNameNorm === rackCleanName) || 
                           (rIdenNorm && rIdenNorm === rackCleanName) || 
                           (rIdNorm && rIdNorm === rackCleanName) ||
                           (rNameNorm && rackCleanName && rNameNorm.includes(rackCleanName)) ||
                           (rackCleanName && rNameNorm && rackCleanName.includes(rNameNorm));
                });

                if (matchedRack) {
                    sanitizeRackStructure(matchedRack);
                    if (matchedRack.cols[colIdx] && matchedRack.cols[colIdx].levels[lvlIdx]) {
                        return `RK-${matchedRack.id}-C${colIdx}-L${lvlIdx}`;
                    }
                }
            }

            // 4. Fallback: Mapear a columna 0 nivel 0
            const matchedRackDirect = RACKS.find(r => r && (
                safeStr(r.id) === locClean || 
                safeStr(r.identifier) === locClean ||
                safeStr(r.name) === locClean
            ));
            if (matchedRackDirect) {
                return `RK-${matchedRackDirect.id}-C0-L0`;
            }

            return ''; 
        } catch (err) {
            console.error("[WMS] Error interno al mapear ubicación. Protegiendo flujo:", err);
            return '';
        }
    }

    auth.onAuthStateChanged(function(user) {
        if(user) {
            document.getElementById('loginScreen').style.display = 'none';
            
            db.ref('bodega').on('value', function(snap) {
                const data = snap.val() || {};

                let rawRows = [];
                if (Array.isArray(data.rows)) rawRows = data.rows;
                else if (data.rows && typeof data.rows === 'object') rawRows = Object.keys(data.rows).map(k => data.rows[k]);
                ROWS = rawRows.filter(r => r !== null && r !== undefined);
                if (ROWS.length === 0) ROWS = [{id:'R1', name:'Fila A', sizeM:15}];

                let rawRacks = [];
                if (Array.isArray(data.racks)) rawRacks = data.racks;
                else if (data.racks && typeof data.racks === 'object') rawRacks = Object.keys(data.racks).map(k => data.racks[k]);
                RACKS = rawRacks.filter(r => r !== null && r !== undefined);
                
                RACKS.forEach(sanitizeRackStructure);

                let rawProducts = [];
                if (Array.isArray(data.products)) rawProducts = data.products;
                else if (data.products && typeof data.products === 'object') rawProducts = Object.keys(data.products).map(k => data.products[k]);
                PRODUCTS = rawProducts.filter(p => p !== null && p !== undefined);

                if (data.history && typeof data.history === 'object') { 
                    HISTORY_LOG = Object.keys(data.history).map(k => data.history[k]).sort((a,b) => new Date(b.dateRaw) - new Date(a.dateRaw)); 
                } else { HISTORY_LOG = []; }

                let rawWH = [];
                if (Array.isArray(data.warehouses)) rawWH = data.warehouses;
                else if (data.warehouses && typeof data.warehouses === 'object') rawWH = Object.keys(data.warehouses).map(k => data.warehouses[k]);
                WAREHOUSES = rawWH.filter(w => w !== null && w !== undefined);
                if (WAREHOUSES.length === 0) WAREHOUSES = [{id: 'WH1', name: 'Bodega Principal', widthM: 30, lengthM: 20, scale: 25}];
                if (!activeWarehouseId) activeWarehouseId = WAREHOUSES[0].id;

                let rawZones = [];
                if (Array.isArray(data.zones)) rawZones = data.zones;
                else if (data.zones && typeof data.zones === 'object') rawZones = Object.keys(data.zones).map(k => data.zones[k]);
                ZONES = rawZones.filter(z => z !== null && z !== undefined);

                if (data.config && data.config.gsheets) {
                    gsheetsConfig = data.config.gsheets;
                }

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
            try {
                RACKS.forEach(sanitizeRackStructure);
                
                db.ref('bodega/rows').set(JSON.parse(JSON.stringify(ROWS)));
                db.ref('bodega/racks').set(JSON.parse(JSON.stringify(RACKS))); 
                db.ref('bodega/products').set(JSON.parse(JSON.stringify(PRODUCTS)));
                db.ref('bodega/warehouses').set(JSON.parse(JSON.stringify(WAREHOUSES)));
                db.ref('bodega/zones').set(JSON.parse(JSON.stringify(ZONES)));
                db.ref('bodega/config/gsheets').set(JSON.parse(JSON.stringify(gsheetsConfig)));
            } catch (e) {
                console.error("Error al sincronizar con Firebase:", e);
            }
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

    function generateProductHTML(p, totalSize, idx, safeName, scale = null, isRack = false) {
        const isInActiveOrder = ACTIVE_ORDER.some(item => item.sku && p.sku && item.sku.toLowerCase() === p.sku.toLowerCase() && !item.completed);
        const pEl = document.createElement('div');
        pEl.className = 'product' + (isRack ? ' rack-product' : '') + (scale ? ' map-mini-product' : '');
        if(currentH === p.sku) pEl.classList.add('is-highlighted');
        if(isInActiveOrder) pEl.classList.add('is-ordered');
        pEl.id = 'p-' + p.sku;
        pEl.draggable = true;
        
        if (!isRack) {
            if (scale) pEl.style.width = ((p.widthM || 0) * scale) + 'px';
            else pEl.style.width = (p.widthM / totalSize * 100) + '%';
        }
        
        pEl.style.background = p.color || '#c8a84b';
        if(!scale && !isRack) {
            pEl.style.background = (p.color || '#c8a84b') + '25';
            pEl.style.borderTop = '6px solid ' + (p.color || '#c8a84b');
        }

        let tooltipText = 'SKU: ' + (p.sku || 'N/A') + '\nProducto: ' + (p.name || 'N/A') + '\nStock Físico: ' + (p.current || 0) + ' (Mín: ' + (p.min || 0) + ' / Máx: ' + (p.max || 0) + ')';
        if (p.widthM || p.heightM || p.depthM) tooltipText += `\nDimensiones SKU: ${p.widthM||0}x${p.heightM||0}x${p.depthM||0} m`;
        if (p.hasPO) tooltipText += '\n📦 Prov. Reservado: ' + (p.reservedStock || 0);
        if (p.masterQty || p.innerQty) tooltipText += '\nEmpaque: Master: ' + (p.masterQty || 0) + ' u. | Interior: ' + (p.innerQty || 0) + ' u.';
        if (p.supplier) tooltipText += '\nProveedor: ' + p.supplier + ' (Demora: ' + (p.leadTime || 0) + ' días)';
        if (isInActiveOrder) tooltipText += '\n\n📦 REQUERIDO EN PEDIDO (Luz Azul)';

        pEl.setAttribute('data-tooltip', tooltipText);
        
        pEl.ondragstart = function(e) {
            globalTooltip.classList.remove('show');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData("text/plain", p.sku); 
            e.dataTransfer.setData("sku", p.sku);
            
            const ghost = document.createElement('div');
            ghost.style.width = '60px'; ghost.style.height = '85px'; ghost.style.background = pEl.style.background;
            ghost.style.borderTop = pEl.style.borderTop; ghost.style.border = '1px solid rgba(255,255,255,0.2)';
            ghost.style.borderRadius = '4px'; ghost.style.display = 'flex'; ghost.style.flexDirection = 'column';
            ghost.style.alignItems = 'center'; ghost.style.justifyContent = 'center'; ghost.style.position = 'absolute';
            ghost.style.top = '-1000px'; ghost.style.zIndex = '100003'; ghost.innerHTML = pEl.innerHTML;
            document.body.appendChild(ghost); e.dataTransfer.setDragImage(ghost, 30, 42); setTimeout(() => document.body.removeChild(ghost), 0);
        };
        
        pEl.onclick = function() { openProductModal(p.sku); };
        
        let dotColor = 'var(--ok)';
        if(p.current < p.min) dotColor = 'var(--danger)';
        else if (p.current <= p.min * 1.2) dotColor = 'var(--warn)';
        else if (p.max > 0 && p.current > p.max) dotColor = 'var(--over)';
        
        const posLabel = isRack ? (idx => p.sku.substring(0,3))(idx) : safeName.split(' ').pop() + (idx + 1);
        pEl.innerHTML = '<div class="product-pos">' + posLabel + '</div><span class="stock-dot" style="background:' + dotColor + '"></span>';
        
        return pEl;
    }

    function renderRackFront(rackId, wrapperElement) {
        wrapperElement.innerHTML = '';
        const rack = RACKS.find(r => r.id === rackId);
        if(!rack) return;
        
        sanitizeRackStructure(rack);

        const colsHTML = document.createElement('div');
        colsHTML.className = 'rack-cols-wrap';

        rack.cols.forEach((col, c) => {
            const colWrap = document.createElement('div');
            colWrap.className = 'rack-col-ui';
            
            col.levels.forEach((lvl, l) => {
                const levelId = `RK-${rack.id}-C${c}-L${l}`;
                const levelEl = document.createElement('div');
                levelEl.className = 'rack-level-ui';
                levelEl.id = levelId;
                
                levelEl.setAttribute('data-rack-id', rack.id);
                levelEl.addEventListener('dragover', e => e.preventDefault());
                levelEl.addEventListener('drop', drop);

                const lbl = document.createElement('div');
                lbl.className = 'rack-level-name';
                lbl.innerText = `C${c+1}-N${l+1} (${lvl.w}x${lvl.h}m) [Cap: ${lvl.cap}]`;
                levelEl.appendChild(lbl);

                const levelProds = PRODUCTS.filter(p => p.rowId === levelId);
                if(levelProds.length >= lvl.cap) levelEl.classList.add('is-full');

                levelProds.forEach((p, idx) => {
                    if(p.current < p.min && document.getElementById('alertBar').style.display === 'none') {
                        document.getElementById('alertBar').style.display = 'flex';
                        document.getElementById('alertText').innerText = 'Stock crítico detectado.';
                    }
                    const pEl = generateProductHTML(p, 0, idx, '', null, true);
                    levelEl.appendChild(pEl);
                });
                colWrap.appendChild(levelEl);
            });
            
            const header = document.createElement('div');
            header.className = 'rack-col-header';
            header.innerText = `Columna ${c+1}`;
            colWrap.appendChild(header);
            
            colsHTML.appendChild(colWrap);
        });
        wrapperElement.appendChild(colsHTML);
    }

    function render() {
        const wrap = document.getElementById('whWrap');
        if(!wrap) return;
        wrap.innerHTML = '';
        
        document.getElementById('alertBar').style.display = 'none';

        const dot = document.getElementById('orderDotStatus');
        if(dot) dot.style.background = ACTIVE_ORDER.length > 0 ? 'var(--order-blue)' : 'grey';

        ROWS.forEach(function(row, idx) {
            const rowProds = PRODUCTS.filter(p => p && p.rowId === row.id);
            const used = rowProds.reduce((s, p) => s + (p.widthM || 0), 0);
            
            let totalSize = row.sizeM || 15;
            if(row.shape === 'L') totalSize = ((row.cap1 || 5) + (row.cap2 || 10)) * 0.6;
            if(row.shape === 'U' || row.shape === 'C') totalSize = ((row.cap1 || 5) + (row.cap2 || 10) + (row.cap3 || 5)) * 0.6;
            
            const perc = totalSize > 0 ? ((used / totalSize) * 100).toFixed(1) : 0;
            const safeName = row.name || 'Sin Nombre';

            const container = document.createElement('div');
            container.className = 'row-container';
            container.style.zIndex = 4000 - idx;
            
            container.setAttribute('data-row-id', row.id);
            container.addEventListener('dragover', ev => ev.preventDefault());
            container.addEventListener('drop', drop);
            
            let headerHTML = `<div class="row-header"><div class="row-info"><b>${safeName}</b> <span>${used.toFixed(2)}m / ${totalSize.toFixed(1)}m (${perc}%)</span></div>`;
            headerHTML += `<button class="btn btn-secondary" style="padding:6px 12px; font-size:0.75rem" onclick="openRowModal('${row.id}')">⚙️ Editar</button></div>`;
            headerHTML += `<div class="row-scroll-wrapper"><div class="wh-row" id="${row.id}"></div></div>`;
            
            container.innerHTML = headerHTML;
            const rowEl = container.querySelector('.wh-row');
            
            rowProds.forEach(function(p, index) {
                const pEl = generateProductHTML(p, totalSize, index, safeName, null, false);
                rowEl.appendChild(pEl);
            });
            wrap.appendChild(container);
        });

        RACKS.forEach(function(rack, idx) {
            const container = document.createElement('div');
            container.className = 'row-container rack-container';
            container.style.zIndex = 3000 - idx;
            
            sanitizeRackStructure(rack);
            
            let headerHTML = `<div class="row-header">
                <div class="row-info">
                    <b style="color:var(--order-blue)">RACK: ${rack.name}</b> 
                    <span style="font-family:'DM Mono', monospace; background:rgba(59, 130, 246, 0.15); color:var(--order-blue); border: 1px solid rgba(59, 130, 246, 0.3); padding: 4px 10px; border-radius: 20px; font-size: 0.85rem; font-weight: 500;">ID: ${rack.identifier || rack.id}</span>
                    <span style="font-size: 0.85rem; color: var(--muted); font-weight: 500; background: rgba(0,0,0,0.3); padding: 4px 10px; border-radius: 20px; border: 1px solid var(--border); margin-left:10px;">${rack.cols.length} Columnas</span>
                </div>
                <div style="display:flex; gap:10px;">
                    <button class="btn btn-secondary" style="padding:6px 12px; font-size:0.75rem" onclick="openRackModal('${rack.id}')">⚙️ Editar Rack</button>
                    <button class="btn btn-danger" style="padding:6px 12px; font-size:0.75rem" onclick="deleteRack('${rack.id}')">🗑️ Eliminar Rack</button>
                </div>
            </div>`;
            
            container.innerHTML = headerHTML;

            const bodyWrapper = document.createElement('div');
            bodyWrapper.className = 'rack-scroll-wrapper';
            bodyWrapper.style.width = '100%';
            bodyWrapper.style.overflowX = 'auto';
            bodyWrapper.style.paddingBottom = '15px';

            renderRackFront(rack.id, bodyWrapper);
            container.appendChild(bodyWrapper);
            
            wrap.appendChild(container);
        });
    }

    function drop(e) {
        e.preventDefault();
        const sku = e.dataTransfer.getData("text/plain") || e.dataTransfer.getData("sku"); 
        if (!sku) return;
        
        let targetRowId = null;
        let isRack = false;
        
        let targetRackLvl = e.currentTarget.closest('.rack-level-ui') || e.target.closest('.rack-level-ui');
        if (targetRackLvl) {
            targetRowId = targetRackLvl.id;
            isRack = true;
        } else {
            targetRowId = e.currentTarget.getAttribute('data-row-id') || e.currentTarget.id;
            if (!targetRowId && e.target.closest('.row-container')) {
                targetRowId = e.target.closest('.row-container').getAttribute('data-row-id');
            }
        }

        if(!targetRowId) return;

        const p = PRODUCTS.find(x => x.sku === sku); 
        if (!p) return;

        const rowProds = PRODUCTS.filter(x => x.rowId === targetRowId && x.sku !== sku);

        if (isRack) {
            const parts = targetRowId.split('-'); 
            const rack = RACKS.find(r => r.id === parts[1]);
            if(!rack) return;
            
            sanitizeRackStructure(rack);
            const colIdx = parseInt(parts[2].substring(1));
            const lvlIdx = parseInt(parts[3].substring(1));
            
            if(!rack.cols[colIdx] || !rack.cols[colIdx].levels[lvlIdx]) return;
            const colCap = rack.cols[colIdx].levels[lvlIdx].cap;
            
            if (rowProds.length >= colCap) return alert("Ubicación llena en este nivel del rack.");
            
            let insertIdx = rowProds.length;
            const children = Array.from(targetRackLvl.children).filter(c => c.id !== 'p-' + p.sku && c.classList.contains('product'));
            children.forEach(function(child, idx) { 
                const rect = child.getBoundingClientRect(); 
                if (e.clientX < (rect.left + rect.width / 2) && insertIdx === rowProds.length) insertIdx = idx; 
            });
            
            rowProds.splice(insertIdx, 0, p); 
            const previousRowId = p.rowId;
            p.rowId = targetRowId;
            
            PRODUCTS = PRODUCTS.filter(x => x.rowId !== targetRowId && x.sku !== p.sku).concat(rowProds); 
            sync();
            if(previousRowId !== targetRowId) logMovement(p.sku, p.name, 0, "Movido a " + rack.name);
            else logMovement(p.sku, p.name, 0, "Reorganizado en " + rack.name);

        } else {
            const used = rowProds.reduce((s, x) => s + (x.widthM || 0), 0); 
            const targetRow = ROWS.find(r => r.id === targetRowId);
            if(!targetRow) return;

            let totalSize = targetRow.sizeM || 15;
            if(targetRow.shape === 'L') totalSize = ((targetRow.cap1 || 5) + (targetRow.cap2 || 10)) * 0.6;
            if(targetRow.shape === 'U' || targetRow.shape === 'C') totalSize = ((targetRow.cap1 || 5) + (targetRow.cap2 || 10) + (targetRow.cap3 || 5)) * 0.6;

            if (used + p.widthM > totalSize + 0.1) return alert("Sin espacio visual configurado para esta fila.");
            
            const rowEl = document.getElementById(targetRowId); 
            if(!rowEl) return;

            const children = Array.from(rowEl.children).filter(c => c.id !== 'p-' + p.sku);
            let insertIdx = children.length;
            children.forEach(function(child, idx) { 
                const rect = child.getBoundingClientRect(); 
                if (e.clientX < (rect.left + rect.width / 2) && insertIdx === children.length) insertIdx = idx; 
            });
            
            rowProds.splice(insertIdx, 0, p); 
            const previousRowId = p.rowId;
            p.rowId = targetRowId;
            
            PRODUCTS = PRODUCTS.filter(x => x.rowId !== targetRowId && x.sku !== p.sku).concat(rowProds); 
            sync();
            
            if(previousRowId !== targetRowId) logMovement(p.sku, p.name, 0, "Movido a fila " + (targetRow.name || 'N/A'));
            else logMovement(p.sku, p.name, 0, "Reorganización en fila " + (targetRow.name || 'N/A'));
        }
    }

    function handleSearch(v, boxId, isDB) {
        const s = document.getElementById(boxId);
        if(!v) { s.style.display='none'; if(isDB) filterDB(''); return; }
        const m = PRODUCTS.filter(function(p) { return (p.sku && String(p.sku).toLowerCase().includes(String(v).toLowerCase())) || (p.name && String(p.name).toLowerCase().includes(String(v).toLowerCase())); });
        s.style.display = m.length ? 'block' : 'none';
        let html = '';
        m.forEach(function(p) { html += '<div class="suggestion-item" onclick="selectSuggestion(\'' + p.sku + '\', \'' + boxId + '\', ' + isDB + ')"><b>' + p.sku + '</b> - ' + p.name + '</div>'; });
        s.innerHTML = html;
        if(isDB) filterDB(v);
    }

    function selectSuggestion(sku, boxId, isDB) { 
        document.getElementById(boxId).style.display = 'none'; 
        if(isDB) { filterDB(sku); } 
        else { 
            currentH = sku; render(); 
            if(currentViewMode === 'map') renderMap();
            const prefix = currentViewMode === 'map' ? 'map-p-' : 'p-';
            const el = document.getElementById(prefix + sku);
            if(el) el.scrollIntoView({behavior:'smooth', block:'center'}); 
        } 
    }

    function openProductModal(sku) {
        const sel = document.getElementById('pRowSelect'); 
        let options = '<optgroup label="Filas">';
        ROWS.forEach(r => options += `<option value="${r.id}">${r.name || 'Sin Nombre'}</option>`);
        options += '</optgroup><optgroup label="Ubicaciones de Racks">';
        
        RACKS.forEach(rack => {
           sanitizeRackStructure(rack);
           rack.cols.forEach((col, c) => {
              col.levels.forEach((lvl, l) => {
                 options += `<option value="RK-${rack.id}-C${c}-L${l}">${rack.name} - C${c+1}-N${l+1}</option>`;
              });
           });
        });
        options += '</optgroup>';
        sel.innerHTML = options;
        tempImg = null;
        
        if(sku && typeof sku === 'string') {
            const p = PRODUCTS.find(x => x.sku === sku); 
            if(!p) return;
            document.getElementById('pSku').value = p.sku; document.getElementById('pSku').disabled = true;
            document.getElementById('pName').value = p.name; document.getElementById('pWidth').value = p.widthM;
            document.getElementById('pHeight').value = p.heightM !== undefined ? p.heightM : '';
            document.getElementById('pDepth').value = p.depthM !== undefined ? p.depthM : '';
            document.getElementById('pColor').value = p.color; document.getElementById('pRowSelect').value = p.rowId;
            document.getElementById('pCurrent').value = p.current; document.getElementById('pMin').value = p.min;
            document.getElementById('pMax').value = p.max || 0; document.getElementById('pMasterQty').value = p.masterQty !== undefined ? p.masterQty : '';
            document.getElementById('pInnerQty').value = p.innerQty !== undefined ? p.innerQty : ''; document.getElementById('pSupplier').value = p.supplier || '';
            document.getElementById('pLeadTime').value = p.leadTime !== undefined ? p.leadTime : ''; 
            document.getElementById('pHasPO').checked = !!p.hasPO;
            document.getElementById('pReservedStock').value = p.reservedStock || 0;
            document.getElementById('pPoDate').value = p.poDate || '';
            document.getElementById('pPoArrival').value = p.poArrival || '';
            document.getElementById('pImgPreview').innerHTML = p.photo ? '<img src="' + p.photo + '">' : '<span style="font-size: 0.85rem; color:var(--muted);">Sin Imagen</span>';
            document.getElementById('btnDelProd').style.display = 'block';
        } else {
            document.getElementById('pSku').value = ''; document.getElementById('pSku').disabled = false; document.getElementById('pName').value = ''; 
            document.getElementById('pWidth').value = '0.56'; document.getElementById('pHeight').value = ''; document.getElementById('pDepth').value = '';
            document.getElementById('pCurrent').value = '0'; document.getElementById('pMin').value = '0'; document.getElementById('pMax').value = '0';
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
            sku: sku, name: name, 
            widthM: parseFloat(document.getElementById('pWidth').value) || 0.56,
            heightM: parseFloat(document.getElementById('pHeight').value) || 0,
            depthM: parseFloat(document.getElementById('pDepth').value) || 0,
            color: document.getElementById('pColor').value || "#c8a84b", rowId: selectedRowId,
            current: newStock, min: parseInt(document.getElementById('pMin').value) || 0, max: parseInt(document.getElementById('pMax').value) || 0,
            masterQty: parseInt(document.getElementById('pMasterQty').value) || 0, innerQty: parseInt(document.getElementById('pInnerQty').value) || 0,
            supplier: document.getElementById('pSupplier').value || "", leadTime: parseInt(document.getElementById('pLeadTime').value) || 0,
            hasPO: document.getElementById('pHasPO').checked, reservedStock: parseInt(document.getElementById('pReservedStock').value) || 0,
            poDate: document.getElementById('pPoDate').value, poArrival: document.getElementById('pPoArrival').value, photo: tempImg || null
        };

        const idx = PRODUCTS.findIndex(p => p.sku === sku);
        let stockDiff = 0;
        let isEdit = false;

        if(idx >= 0) {
            isEdit = true;
            stockDiff = newStock - PRODUCTS[idx].current;
            PRODUCTS[idx] = Object.assign({}, PRODUCTS[idx], data);
        } else {
            PRODUCTS.push(data);
        }
        
        sync(); 

        if (isEdit && stockDiff !== 0) {
            logMovement(sku, data.name, stockDiff, "Edición Manual");
        } else if (!isEdit) {
            logMovement(sku, data.name, newStock, "Creación de Producto");
        }
        closeProductModalOnly();
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
                activeRows += '<tr><td><b style="color:var(--text);">' + (p.sku||'') + '</b><br><small style="color:var(--muted)">' + (p.name||'') + '</small></td><td>' + (p.supplier || 'N/A') + '</td><td style="color:var(--accent); font-weight:bold; text-align:center;">' + (p.current||0) + '</td><td style="text-align:center;">' + (p.reservedStock || 0) + '</td><td style="text-align:center;"><b style="color:var(--order-blue)">' + toOrder + '</b></td><td>' + alertHTML + '</td></tr>';
            } else {
                if (p.current <= (p.min * 1.5)) {
                    newRows += '<tr><td><b style="color:var(--text);">' + (p.sku||'') + '</b><br><small style="color:var(--muted)">' + (p.name||'') + '</small></td><td>' + (p.supplier || 'N/A') + '</td><td style="text-align:center;">' + (p.leadTime || 0) + ' días</td><td style="color:var(--danger); font-weight:bold; text-align:center; font-size:1.1rem;">' + (p.current||0) + '</td><td style="text-align:center;">' + (p.min||0) + ' / ' + (p.max || 0) + '</td><td style="text-align:center;"><b style="color:var(--warn); font-size:1.1rem;">' + toOrder + '</b></td><td style="font-size:0.8rem; color:var(--muted);">Sol: ' + (p.poDate || '-') + '<br>Lleg: ' + (p.poArrival || '-') + '</td></tr>';
                }
            }
        });

        bActive.innerHTML = activeRows || '<tr><td colspan="6" style="text-align:center; padding: 20px; color: var(--muted);">No hay productos con contrato vigente.</td></tr>';
        bNew.innerHTML = newRows || '<tr><td colspan="7" style="text-align:center; padding: 20px; color: var(--muted);">Ningún producto urgente por solicitar.</td></tr>';
        document.getElementById('poModal').classList.add('open');
    }

    function filterDB(q) {
        const b = document.getElementById('dbTableBody'); let html = '';
        PRODUCTS.filter(p => (p.sku && String(p.sku).toLowerCase().includes(String(q).toLowerCase())) || (p.name && String(p.name).toLowerCase().includes(String(q).toLowerCase()))).forEach(function(p) {
            
            let pos = 'S/N';
            if (p.rowId) {
                 if (p.rowId.startsWith('RK-')) {
                     const parts = p.rowId.split('-');
                     const r = RACKS.find(x => x.id === parts[1]);
                     if(r) {
                         const c = parseInt(parts[2].replace('C','')) + 1;
                         const l = parseInt(parts[3].replace('L','')) + 1;
                         pos = `${r.name} (C${c}-N${l})`;
                     }
                 } else {
                     const row = ROWS.find(r => r.id === p.rowId);
                     const pIdx = PRODUCTS.filter(x => x.rowId === p.rowId).findIndex(x => x.sku === p.sku) + 1;
                     pos = row ? `${row.name} (Pos. ${pIdx})` : 'S/N';
                 }
            }
            
            const displayStock = DB_CHANGES[p.sku] !== undefined ? DB_CHANGES[p.sku] : p.current;
            
            let rowStyle = ''; let statusLabel = '';
            if(p.current < p.min) { rowStyle = 'background: rgba(239, 68, 68, 0.05); border-left: 4px solid var(--danger);'; statusLabel = '<span class="status-badge" style="background:rgba(239,68,68,0.15); color:var(--danger);">Crítico</span>'; }
            else if (p.current <= p.min * 1.2) { rowStyle = 'background: rgba(245, 158, 11, 0.05); border-left: 4px solid var(--warn);'; statusLabel = '<span class="status-badge" style="background:rgba(245,158,11,0.15); color:var(--warn);">Alerta</span>'; }
            else if (p.max > 0 && p.current > p.max) { rowStyle = 'background: rgba(139, 92, 246, 0.05); border-left: 4px solid var(--over);'; statusLabel = '<span class="status-badge" style="background:rgba(139,92,246,0.15); color:var(--over);">Sobre Stock</span>'; }
            else { rowStyle = 'border-left: 4px solid transparent;'; statusLabel = '<span class="status-badge" style="background:rgba(16,185,129,0.1); color:var(--ok);">Saludable</span>'; }

            html += `<tr style="${rowStyle}"><td><b style="color:var(--accent)">${pos}</b></td><td><span style="font-family:'DM Mono', monospace; color:var(--muted);">${p.sku||''}</span></td><td style="font-weight:500;">${p.name||''}</td><td style="text-align:center;"><input type="number" value="${displayStock}" oninput="DB_CHANGES['${p.sku}'] = parseInt(this.value) || 0" style="margin:0; font-weight:bold;"></td><td>${p.min||0}</td><td>${p.max || 0}</td><td>${statusLabel}</td><td><button class="btn btn-secondary" style="padding:6px 12px; font-size:0.75rem;" onclick="openProductModal('${p.sku}')">Editar</button></td></tr>`;
        });
        b.innerHTML = html;
    }

    function openInventoryDB() { DB_CHANGES = {}; document.getElementById('sapImportSection').style.display = 'none'; document.getElementById('sapPasteInput').value = ''; document.getElementById('dbModal').classList.add('open'); filterDB(''); }

    function applyDBChanges() {
        let pendingLogs = [];
        Object.keys(DB_CHANGES).forEach(function(sku) { 
            const pIdx = PRODUCTS.findIndex(x => x.sku === sku); 
            if(pIdx >= 0) {
                const newStock = parseInt(DB_CHANGES[sku]) || 0;
                if (PRODUCTS[pIdx].current !== newStock) {
                    pendingLogs.push({sku: sku, name: PRODUCTS[pIdx].name, change: newStock - PRODUCTS[pIdx].current, reason: "Ajuste Masivo Tabla"});
                    PRODUCTS[pIdx].current = newStock;
                }
            } 
        });
        sync(); 
        pendingLogs.forEach(log => logMovement(log.sku, log.name, log.change, log.reason));
        closeModals();
    }

    function openHistoryModal() {
        const b = document.getElementById('historyTableBody'); let html = '';
        if(HISTORY_LOG.length === 0) { html = '<tr><td colspan="6" style="text-align:center; padding:20px; color:var(--muted);">No hay movimientos registrados.</td></tr>'; } 
        else {
            HISTORY_LOG.forEach(function(log) {
                const isPos = String(log.change).startsWith('+');
                const color = isPos ? 'var(--ok)' : 'var(--danger)';
                html += `<tr><td style="color:var(--muted); font-size:0.8rem;">${log.date}</td><td><span style="font-family:'DM Mono', monospace; color:var(--accent);">${log.sku||''}</span></td><td style="font-weight:500;">${log.name||''}</td><td><b style="color:${color}; font-size:1.1rem;">${log.change}</b></td><td style="font-size:0.8rem; color:var(--muted);">${log.user||''}</td><td style="color:var(--text);"><i>${log.reason||''}</i></td></tr>`;
            });
        }
        b.innerHTML = html;
        document.getElementById('historyModal').classList.add('open');
    }

    function toggleSapSection() { const section = document.getElementById('sapImportSection'); section.style.display = section.style.display === 'none' ? 'block' : 'none'; }

    // BLINDAJE EXTRA: Importación SAP segura (Envuelve en Try/Catch para nunca romper el render)
    function processSapPaste() {
        const inputData = document.getElementById('sapPasteInput').value.trim(); 
        if (!inputData) return alert("El cuadro de texto está vacío.");
        const lines = inputData.split('\n'); let updatedCount = 0; let createdCount = 0;
        
        let pendingLogs = [];

        try {
            lines.forEach(function(line) {
                const cleanLine = line.replace(/\r/g, ''); 
                const delimiter = cleanLine.includes('\t') ? '\t' : (cleanLine.includes(';') ? ';' : ',');
                const cols = cleanLine.split(delimiter);
                
                if (cols.length >= 2) {
                    const sku = cols[0] ? String(cols[0]).trim() : ''; 
                    if (!sku) return; 
                    
                    const name = cols[1] ? String(cols[1]).trim() : "Vino Importado";
                    const qtyStr = cols[2] ? String(cols[2]).trim().replace(/\./g,'').replace(/,/g,'') : ''; 
                    const qty = qtyStr ? parseInt(qtyStr) : 0;
                    
                    const pIdx = PRODUCTS.findIndex(p => p.sku && String(p.sku).toLowerCase() === sku.toLowerCase());
                    
                    let mappedLocationId = '';
                    if (cols[3] && String(cols[3]).trim() !== '') {
                        mappedLocationId = findLocationId(String(cols[3]).trim());
                    }

                    if (pIdx >= 0) {
                        if (!isNaN(qty) && qtyStr !== "" && PRODUCTS[pIdx].current !== qty) { 
                            pendingLogs.push({sku: sku, name: name, change: qty - PRODUCTS[pIdx].current, reason: "Importación SAP"});
                            PRODUCTS[pIdx].current = qty; 
                            updatedCount++; 
                        }
                        if (cols[1] && String(cols[1]).trim() !== '') PRODUCTS[pIdx].name = String(cols[1]).trim();
                        if (mappedLocationId) {
                            PRODUCTS[pIdx].rowId = mappedLocationId;
                        }
                        if (cols[4] && String(cols[4]).trim() !== '') PRODUCTS[pIdx].masterQty = parseInt(cols[4]) || 0;
                        if (cols[5] && String(cols[5]).trim() !== '') PRODUCTS[pIdx].innerQty = parseInt(cols[5]) || 0;
                        if (cols[6] && String(cols[6]).trim() !== '') PRODUCTS[pIdx].min = parseInt(cols[6]) || 0;
                        if (cols[7] && String(cols[7]).trim() !== '') PRODUCTS[pIdx].max = parseInt(cols[7]) || 0;
                        if (cols[8] && String(cols[8]).trim() !== '') PRODUCTS[pIdx].supplier = String(cols[8]).trim();
                        if (cols[9] && String(cols[9]).trim() !== '') PRODUCTS[pIdx].leadTime = parseInt(cols[9]) || 0;
                    } else {
                        let targetRowId = mappedLocationId || (ROWS.length > 0 ? ROWS[0].id : ''); 
                        const newProd = { 
                            sku: sku, name: name, widthM: 0.56, heightM: 0, depthM: 0, color: "#c8a84b", rowId: targetRowId, current: isNaN(qty) ? 0 : qty, 
                            masterQty: cols[4] ? (parseInt(cols[4]) || 0) : 0, 
                            innerQty: cols[5] ? (parseInt(cols[5]) || 0) : 0, 
                            min: cols[6] ? (parseInt(cols[6]) || 0) : 0, 
                            max: cols[7] ? (parseInt(cols[7]) || 0) : 0, 
                            supplier: cols[8] ? String(cols[8]).trim() : "", 
                            leadTime: cols[9] ? (parseInt(cols[9]) || 0) : 0,
                            hasPO: false, reservedStock: 0, photo: null 
                        };
                        PRODUCTS.push(newProd); 
                        pendingLogs.push({sku: sku, name: name, change: newProd.current, reason: "Alta desde SAP/Excel"});
                        createdCount++;
                    }
                }
            });

            document.getElementById('sapPasteInput').value = '';
            alert(`Proceso finalizado.\nActualizados: ${updatedCount}\nCreados: ${createdCount}`); 
            
            sync(); 
            pendingLogs.forEach(log => logMovement(log.sku, log.name, log.change, log.reason));
            filterDB('');
        } catch (err) {
            console.error("[WMS] Error crítico en importación SAP:", err);
            alert("Ocurrió un error leyendo las filas pegadas. Revisa la consola.");
        }
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
            const p = PRODUCTS.find(x => x.sku && x.sku.toLowerCase() === item.sku.toLowerCase());
            let locationLabel = "<span style='color:var(--danger); font-weight:600;'>⚠️ No está en racks</span>";
            if (p) {
                if (p.rowId && p.rowId.startsWith('RK-')) {
                     const parts = p.rowId.split('-');
                     const r = RACKS.find(x => x.id === parts[1]);
                     if(r) {
                         const c = parseInt(parts[2].replace('C','')) + 1;
                         const l = parseInt(parts[3].replace('L','')) + 1;
                         locationLabel = `<b style="color:var(--order-blue)">${r.name} (C${c}-N${l})</b>`;
                     }
                 } else {
                     const row = ROWS.find(r => r.id === p.rowId);
                     const pIdx = PRODUCTS.filter(x => x.rowId === p.rowId).findIndex(x => x.sku === p.sku) + 1;
                     locationLabel = row ? `<b style="color:var(--accent)">${row.name} (Pos. ${pIdx})</b>` : 'S/N';
                 }
            }
            const rowStyle = item.completed ? 'opacity: 0.35; background: rgba(0,0,0,0.4);' : '';
            const textStyle = item.completed ? 'text-decoration: line-through;' : '';
            
            html += `<tr style="${rowStyle}">` +
                `<td style="text-align:center;"><input type="checkbox" ${item.completed ? 'checked' : ''} onchange="toggleOrderItem(${index})"></td>` +
                `<td style="${textStyle}">${locationLabel}</td>` +
                `<td style="${textStyle}"><span style="font-family:'DM Mono', monospace; color:var(--muted);">${item.sku}</span></td>` +
                `<td style="${textStyle} font-weight:500;">${p ? p.name : item.name}</td>` +
                `<td style="${textStyle} text-align:center;"><b style="font-size:1.1rem; color:var(--accent);">${item.requested}</b></td>` +
                `<td style="text-align:center;"><input type="number" value="${item.picked}" style="width:90px; text-align:center; background:var(--bg); border:1px solid var(--border); color:#fff; padding:6px; border-radius:4px; margin:0;" oninput="updateOrderPickedQty(${index}, this.value)" ${item.completed ? 'disabled' : ''}></td>` +
            `</tr>`;
        });
        tbody.innerHTML = html;
    }

    function toggleOrderItem(index) { 
        ACTIVE_ORDER[index].completed = !ACTIVE_ORDER[index].completed; 
        renderOrderPrepTable(); render(); 
        if(currentViewMode === 'map') renderMap();
        sync(); 
    }

    function updateOrderPickedQty(index, value) { ACTIVE_ORDER[index].picked = parseInt(value) || 0; }
    function cancelActiveOrder() { if (confirm("¿Vaciar pedido y quitar alertas azules en bodega?")) { ACTIVE_ORDER = []; sync(); closeModals(); } }

    function finalizeOrder() {
        let countDespachados = 0;
        let pendingLogs = [];
        ACTIVE_ORDER.forEach(function(item) {
            const pIdx = PRODUCTS.findIndex(x => x.sku && x.sku.toLowerCase() === item.sku.toLowerCase());
            if (pIdx >= 0) {
                const oldStock = PRODUCTS[pIdx].current;
                PRODUCTS[pIdx].current -= item.picked;
                if (PRODUCTS[pIdx].current < 0) PRODUCTS[pIdx].current = 0; 
                const descontado = oldStock - PRODUCTS[pIdx].current;
                if(descontado > 0) { 
                    pendingLogs.push({sku: PRODUCTS[pIdx].sku, name: PRODUCTS[pIdx].name, change: -descontado, reason: "Despacho Pedido (" + item.requested + ")"});
                    countDespachados++; 
                }
            }
        });
        alert("¡Inventario Descontado! Se actualizó el stock de " + countDespachados + " productos.");
        ACTIVE_ORDER = []; 
        sync(); 
        pendingLogs.forEach(log => logMovement(log.sku, log.name, log.change, log.reason));
        closeModals();
    }

    function deleteProduct() { 
        if(confirm("¿Seguro de eliminar producto?")) { 
            const sku = document.getElementById('pSku').value; 
            const name = document.getElementById('pName').value;
            const current = document.getElementById('pCurrent').value;
            PRODUCTS = PRODUCTS.filter(p => p.sku !== sku); 
            sync(); 
            logMovement(sku, name, -current, "Eliminado del Sistema"); 
            closeProductModalOnly(); 
        } 
    }

    function openRowModal(id) { 
        let r = {id:'', name:'', sizeM:15, shape:'straight'};
        if (id && typeof id === 'string' && id.trim() !== '') {
            const found = ROWS.find(x => x.id === id);
            if (found) r = found;
        }
        document.getElementById('rId').value = r.id; 
        document.getElementById('rName').value = r.name || ''; 
        document.getElementById('rSize').value = r.sizeM || 15; 
        document.getElementById('rDepth').value = r.depthM || 1.2;
        
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
            name: document.getElementById('rName').value || 'Nueva Fila', 
            sizeM: parseFloat(document.getElementById('rSize').value) || 15,
            shape: shapeSelect ? shapeSelect.value : 'straight',
            depthM: parseFloat(document.getElementById('rDepth').value) || 1.2
        }; 
        
        const idx = ROWS.findIndex(x => x.id === data.id);
        if(idx >= 0) {
            data.whId = ROWS[idx].whId; data.x = ROWS[idx].x; data.y = ROWS[idx].y; data.rotation = ROWS[idx].rotation;
            data.cap1 = ROWS[idx].cap1; data.cap2 = ROWS[idx].cap2; data.cap3 = ROWS[idx].cap3;
            ROWS[idx] = data;
        } else { 
            ROWS.push(data); 
        }
        sync(); closeModals(); 
    }

    function deleteRow() { const id = document.getElementById('rId').value; if(PRODUCTS.some(p => p.rowId === id)) return alert("Fila con productos. Mueve los productos antes."); if(confirm("¿Eliminar fila?")) { ROWS = ROWS.filter(r => r.id !== id); sync(); closeModals(); } }
    
    // FUNCIONES ADMINISTRATIVAS DE RACKS
    function openRackModal(id) {
        let r = {id:'', identifier:'', name:'', widthM: 2, depthM: 1, cols: [] };
        if (id && typeof id === 'string') {
            const found = RACKS.find(x => x.id === id);
            if (found) r = JSON.parse(JSON.stringify(found));
        }
        
        sanitizeRackStructure(r);
        if(r.cols.length === 0) r.cols.push({levels: [{cap:10, w:1.2, h:1.0}]});

        document.getElementById('rkId').value = r.id;
        document.getElementById('rkName').value = r.name || '';
        document.getElementById('rkIdentifier').value = r.identifier || '';
        document.getElementById('rkWidth').value = r.widthM || 2;
        document.getElementById('rkDepth').value = r.depthM || 1;
        document.getElementById('rkColCount').value = r.cols.length;
        
        window.tempRackCols = r.cols;
        renderRackColConfig();
        
        document.getElementById('btnDelRack').style.display = id ? 'block' : 'none';
        document.getElementById('rackModal').classList.add('open');
    }

    function renderRackColConfig() {
        const count = parseInt(document.getElementById('rkColCount').value) || 1;
        
        while(window.tempRackCols.length < count) window.tempRackCols.push({levels: [{cap:10, w:1.2, h:1.0}]});
        while(window.tempRackCols.length > count) window.tempRackCols.pop();

        let html = '';
        window.tempRackCols.forEach((col, cIdx) => {
            html += `<div class="panel-box" style="padding:15px; margin-bottom:15px; background:rgba(0,0,0,0.4);">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
                    <h4 style="font-size:0.9rem; color:var(--order-blue);">Columna ${cIdx+1}</h4>
                    <div style="display:flex; align-items:center; gap:10px;">
                        <label style="font-size:0.75rem; color:var(--muted);">Niveles:</label>
                        <input type="number" id="rkLvl_${cIdx}" min="1" max="20" style="width:70px; padding:4px;" value="${col.levels.length}" onchange="updateRackLvlCount(${cIdx}, this.value)">
                    </div>
                </div>
                <div style="display:grid; gap:10px;">`;
            
            col.levels.forEach((lvl, lIdx) => {
                html += `<div style="display:flex; gap:10px; background:rgba(255,255,255,0.02); padding:10px; border-radius:4px; align-items:center; flex-wrap:wrap;">
                    <span style="color:var(--muted); font-size:0.75rem; font-weight:bold; width:40px;">N${lIdx+1}</span>
                    <div class="field small" style="margin:0; flex:1; min-width:80px;"><label>Cap. Cajas</label><input type="number" id="rkCap_${cIdx}_${lIdx}" value="${lvl.cap}"></div>
                    <div class="field small" style="margin:0; flex:1; min-width:80px;"><label>Ancho (M)</label><input type="number" step="0.1" id="rkW_${cIdx}_${lIdx}" value="${lvl.w}"></div>
                    <div class="field small" style="margin:0; flex:1; min-width:80px;"><label>Alto (M)</label><input type="number" step="0.1" id="rkH_${cIdx}_${lIdx}" value="${lvl.h}"></div>
                </div>`;
            });
            html += `</div></div>`;
        });
        document.getElementById('rkColsConfig').innerHTML = html;
    }

    function updateRackLvlCount(cIdx, val) {
        const count = parseInt(val) || 1;
        const col = window.tempRackCols[cIdx];
        while(col.levels.length < count) col.levels.push({cap:10, w:1.2, h:1.0});
        while(col.levels.length > count) col.levels.pop();
        renderRackColConfig();
    }

    function saveRack() {
        try {
            const id = document.getElementById('rkId').value || 'RK' + Date.now();
            const name = document.getElementById('rkName').value.trim() || 'Nuevo Rack';
            const identifier = document.getElementById('rkIdentifier').value.trim() || '';
            const widthM = parseFloat(document.getElementById('rkWidth').value) || 2;
            const depthM = parseFloat(document.getElementById('rkDepth').value) || 1;
            const colCount = parseInt(document.getElementById('rkColCount').value) || 1;

            if (!name) return alert("El nombre del rack es obligatorio.");

            let newCols = [];
            for (let c = 0; c < colCount; c++) {
                const lvlInput = document.getElementById(`rkLvl_${c}`);
                const levelsCount = lvlInput ? parseInt(lvlInput.value) : 1;
                
                let levels = [];
                for (let l = 0; l < levelsCount; l++) {
                    const capEl = document.getElementById(`rkCap_${c}_${l}`);
                    const wEl = document.getElementById(`rkW_${c}_${l}`);
                    const hEl = document.getElementById(`rkH_${c}_${l}`);
                    
                    levels.push({
                        cap: capEl ? (parseInt(capEl.value) || 0) : 10,
                        w: wEl ? (parseFloat(wEl.value) || 0) : 1.2,
                        h: hEl ? (parseFloat(hEl.value) || 0) : 1.0
                    });
                }
                newCols.push({ levels: levels });
            }

            const oldRack = RACKS.find(r => r.id === id);
            
            if (oldRack) {
                let orphaned = false;
                PRODUCTS.forEach(p => {
                    if (p.rowId && p.rowId.startsWith(`RK-${id}-`)) {
                        const parts = p.rowId.split('-'); 
                        const c = parseInt(parts[2].substring(1));
                        const l = parseInt(parts[3].substring(1));
                        if (!newCols[c] || !newCols[c].levels || !newCols[c].levels[l]) {
                            orphaned = true;
                        }
                    }
                });
                
                if (orphaned) {
                    alert("OPERACIÓN DENEGADA: Estás reduciendo la cantidad de columnas o niveles y hay productos en ubicaciones que desaparecerían. Mueve los productos a otro rack antes de achicar este.");
                    return;
                }
            }

            const rackData = {
                id: id,
                identifier: identifier,
                name: name,
                widthM: widthM,
                depthM: depthM,
                cols: newCols
            };

            const idx = RACKS.findIndex(x => x.id === id);
            if (idx >= 0) {
                rackData.whId = RACKS[idx].whId; 
                rackData.x = RACKS[idx].x; 
                rackData.y = RACKS[idx].y; 
                rackData.rotation = RACKS[idx].rotation;
                RACKS[idx] = rackData;
            } else {
                RACKS.push(rackData);
            }

            sync();
            closeModals();
            
        } catch (err) {
            console.error("[DEBUG] Error crítico no controlado en saveRack:", err);
            alert("Ocurrió un error al guardar el rack. Revisa la consola para más detalles.");
        }
    }
    
    function deleteRack(rackId) {
        const id = (typeof rackId === 'string') ? rackId : document.getElementById('rkId').value;
        if(!id) return;
        if(PRODUCTS.some(p => p.rowId && p.rowId.startsWith('RK-' + id + '-'))) return alert("Rack con productos vivos. Mueve los productos a otro rack o fila antes de eliminar.");
        if(confirm("¿Seguro que deseas eliminar este rack completamente del sistema?\n\nEsta acción eliminará el rack del plano, pero NO afectará el inventario ni el historial.")) { 
            RACKS = RACKS.filter(r => r.id !== id); 
            sync(); 
            closeModals(); 
        }
    }

    function openRackFrontModal(id) {
        window.currentInspectRackId = id;
        const rack = RACKS.find(r => r.id === id);
        if(!rack) return;
        document.getElementById('rackFrontTitle').innerText = 'Inspección: RACK ' + rack.name;
        renderRackFront(id, document.getElementById('rackFrontBody'));
        document.getElementById('rackFrontModal').classList.add('open');
    }

    function processImage(input) { if (input.files && input.files[0]) { const reader = new FileReader(); reader.onload = function(e) { const img = new Image(); img.onload = function() { const canvas = document.createElement('canvas'); const scale = 300 / img.width; canvas.width = 300; canvas.height = img.height * scale; canvas.getContext('2d').drawImage(img, 0,0,300, canvas.height); tempImg = canvas.toDataURL('image/jpeg', 0.6); document.getElementById('pImgPreview').innerHTML = '<img src="' + tempImg + '" style="max-height:160px; border-radius:4px;">'; }; img.src = e.target.result; }; reader.readAsDataURL(input.files[0]); } }
    function closeModals() { window.currentInspectRackId = null; document.querySelectorAll('.modal').forEach(m => m.classList.remove('open')); }
    function closeProductModalOnly() { document.getElementById('productModal').classList.remove('open'); }

    /* ─── ROBOT DE CORREOS AUTOMÁTICOS ─── */
    const EMAILJS_PUBLIC_KEY = "cdusqn38kGYK4HyVj"; 
    const EMAILJS_SERVICE_ID = "service_00sszf8"; 
    const EMAILJS_TEMPLATE_ID = "template_1n41bpp"; 
    const CORREOS_DESTINATARIOS = [ "bodegavct@gmail.com", "nestor.mellado@vctchile.com", "jairo.escobedo@vctchile.com" ];
    if(typeof emailjs !== 'undefined') emailjs.init(EMAILJS_PUBLIC_KEY);

    function verificarYEnviarReporteDiario() {
        const ahora = new Date(); const hoyStr = ahora.toISOString().split('T')[0];
        const horaActual = ahora.getHours(); 
        
        if (horaActual >= 8) {
            const ultimoEnvio = localStorage.getItem('ultimoReporteStock');
            if (ultimoEnvio !== hoyStr) {
                localStorage.setItem('ultimoReporteStock', hoyStr); 
                
                const criticos = PRODUCTS.filter(p => p && p.current < p.min);
                if (criticos.length === 0) return; 

                let filas = "";
                criticos.forEach(function(p) { 
                    filas += `<tr><td style="padding:14px; border-bottom:1px solid #38352f; color:#d4af37; font-weight:bold;">${p.sku||''}</td><td style="padding:14px; border-bottom:1px solid #38352f; color:#f0ede6;">${p.name||''}</td><td style="padding:14px; border-bottom:1px solid #38352f; color:#ef4444; text-align:center; font-weight:bold;">${p.current||0}</td><td style="padding:14px; border-bottom:1px solid #38352f; color:#a39c93; text-align:center;">${p.min||0}</td></tr>`; 
                });
                const htmlContent = `<div style="background:#0d0c0b; color:#f0ede6; font-family:sans-serif; padding:45px; max-width:650px; margin:auto; border:1px solid #38352f; border-radius:16px;"><h2 style="color:#d4af37; border-bottom:1px solid #38352f; padding-bottom:15px; text-transform:uppercase; letter-spacing:1px; margin-top:0;">Alerta de Reposición — Concha y Toro</h2><p style="color:#a39c93; font-size:15px;">Reporte automático diario de productos bajo el stock mínimo:</p><table style="width:100%; border-collapse:collapse; margin-top:25px;"><thead><tr style="background:#1a1916; color:#a39c93; font-size:13px; text-transform:uppercase; letter-spacing:0.5px;"><th style="padding:14px; text-align:left; border-bottom:2px solid #38352f;">SKU</th><th style="padding:14px; text-align:left; border-bottom:2px solid #38352f;">Producto</th><th style="padding:14px; text-align:center; border-bottom:2px solid #38352f;">Stock</th><th style="padding:14px; text-align:center; border-bottom:2px solid #38352f;">Mín.</th></tr></thead><tbody style="font-size:14px;">${filas}</tbody></table></div>`;
                
                if(typeof emailjs !== 'undefined') {
                    CORREOS_DESTINATARIOS.forEach(correo => { 
                        emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, { tablaHTML: htmlContent, to_email: correo }).catch(err => console.error(err)); 
                    });
                }
            }
        }
    }

    /* ─── VISTA AÉREA INTERACTIVA (MAPA 2D) ─── */
    function clearMapSelection() {
        selectedMapItem = null;
        const panel = document.getElementById('mapContextPanel');
        if(panel) panel.style.display = 'none';
        renderMap();
    }

    function selectMapItem(type, id) {
        selectedMapItem = { type: type, id: id };
        renderMap(); 
        
        const panel = document.getElementById('mapContextPanel');
        const inputsWrap = document.getElementById('mapContextInputs');
        const actionBtnWrap = document.getElementById('mapContextActionButtons');
        document.getElementById('mapSaveFeedback').style.display = 'none';
        
        let html = '';
        let buttonsHtml = '';

        if (type === 'row') {
            const row = ROWS.find(r => r.id === id);
            if(!row) return;
            const shape = row.shape || 'straight';
            let c1 = row.cap1 || 5, c2 = row.cap2 || 10, c3 = row.cap3 || 5;
            let d = row.depthM || 1.2;
            
            html += `<div class="field small"><label>Nombre Fila</label><input type="text" id="ctxRowName" value="${row.name||''}"></div>`;
            html += `<div class="field small"><label>Ángulo Rotación (°)</label><input type="number" id="ctxRot" value="${row.rotation||0}"></div>`;
            html += `<div class="field small"><label>Alto / Profundidad Visual (M)</label><input type="number" step="0.1" id="ctxDepth" value="${d}"></div>`;
            
            if (shape === 'L') {
                html += `<div class="field small"><label>Cajas Vertical (Capacidad)</label><input type="number" step="1" id="ctxCap1" value="${c1}"></div>`;
                html += `<div class="field small"><label>Cajas Horizontal (Capacidad)</label><input type="number" step="1" id="ctxCap2" value="${c2}"></div>`;
            } else if (shape === 'U' || shape === 'C') {
                html += `<div class="field small"><label>Cajas Izquierda (Capacidad)</label><input type="number" step="1" id="ctxCap1" value="${c1}"></div>`;
                html += `<div class="field small"><label>Cajas Central (Capacidad)</label><input type="number" step="1" id="ctxCap2" value="${c2}"></div>`;
                html += `<div class="field small"><label>Cajas Derecha (Capacidad)</label><input type="number" step="1" id="ctxCap3" value="${c3}"></div>`;
            } else {
                let size = row.sizeM || 15;
                html += `<div class="field small"><label>Largo Visual (M)</label><input type="number" step="0.5" id="ctxSize" value="${size}"></div>`;
            }
            
            buttonsHtml = `<button class="btn btn-secondary" style="flex:1; padding:8px; font-size:0.75rem;" onclick="unassignMapItem()">📥 Bandeja</button><button class="btn btn-primary" style="flex:2; padding:8px; font-size:0.75rem;" onclick="saveMapItem()">💾 Guardar Fila</button>`;
            
        } else if (type === 'rack') {
            const rk = RACKS.find(x => x.id === id);
            if(!rk) return;
            html += `<div class="field small"><label>Nombre Rack</label><input type="text" id="ctxRowName" value="${rk.name||''}"></div>`;
            html += `<div class="field small"><label>Identificador Interno</label><input type="text" id="ctxRowIden" value="${rk.identifier||''}"></div>`;
            html += `<div class="field small"><label>Ángulo Rotación (°)</label><input type="number" id="ctxRot" value="${rk.rotation||0}"></div>`;
            html += `<div class="field small"><label>Ancho 2D (M)</label><input type="number" step="0.1" id="ctxSize" value="${rk.widthM||2}"></div>`;
            html += `<div class="field small"><label>Profundidad 2D (M)</label><input type="number" step="0.1" id="ctxDepth" value="${rk.depthM||1}"></div>`;
            
            buttonsHtml = `<button class="btn btn-secondary" style="flex:1; padding:8px; font-size:0.75rem;" onclick="unassignMapItem()">📥 Bandeja</button><button class="btn btn-primary" style="flex:1; padding:8px; font-size:0.75rem;" onclick="saveMapItem()">💾 Guardar Rack</button><button class="btn btn-secondary" style="width:100%; border-color:var(--order-blue); color:var(--order-blue); padding:8px; font-size:0.75rem; font-weight:bold;" onclick="openRackFrontModal('${rk.id}')">🔍 Inspeccionar Niveles</button>`;

        } else if (type === 'zone') {
            const z = ZONES.find(x => x.id === id);
            if(!z) return;
            html += `<div class="field small"><label>Nombre Pasillo</label><input type="text" id="ctxZoneName" value="${z.name||''}"></div>`;
            html += `<div class="field small"><label>Ángulo Rotación (°)</label><input type="number" id="ctxRot" value="${z.rotation||0}"></div>`;
            html += `<div class="field small"><label>Ancho (M)</label><input type="number" step="0.5" id="ctxZoneW" value="${z.widthM||2}"></div>`;
            html += `<div class="field small"><label>Largo (M)</label><input type="number" step="0.5" id="ctxZoneL" value="${z.lengthM||10}"></div>`;
            
            buttonsHtml = `<button class="btn btn-danger" style="flex:1; padding:8px; font-size:0.75rem;" onclick="deleteMapItem()">🗑️ Eliminar</button><button class="btn btn-primary" style="flex:2; padding:8px; font-size:0.75rem;" onclick="saveMapItem()">💾 Guardar Pasillo</button>`;
        }
        
        inputsWrap.innerHTML = html;
        actionBtnWrap.style.flexWrap = 'wrap';
        actionBtnWrap.innerHTML = buttonsHtml;
        panel.style.display = 'block';
    }

    function saveMapItem() {
        if(!selectedMapItem) return;
        const t = selectedMapItem.type;
        const id = selectedMapItem.id;
        
        if(t === 'row') {
            const row = ROWS.find(r => r.id === id);
            if(!row) return;
            row.name = document.getElementById('ctxRowName').value;
            row.rotation = parseFloat(document.getElementById('ctxRot').value) || 0;
            row.depthM = parseFloat(document.getElementById('ctxDepth').value) || 1.2;
            
            if(row.shape === 'L') {
                row.cap1 = parseInt(document.getElementById('ctxCap1').value) || 5;
                row.cap2 = parseInt(document.getElementById('ctxCap2').value) || 10;
            } else if (row.shape === 'U' || row.shape === 'C') {
                row.cap1 = parseInt(document.getElementById('ctxCap1').value) || 5;
                row.cap2 = parseInt(document.getElementById('ctxCap2').value) || 10;
                row.cap3 = parseInt(document.getElementById('ctxCap3').value) || 5;
            } else {
                row.sizeM = parseFloat(document.getElementById('ctxSize').value) || 15;
            }
        } else if (t === 'rack') {
            const rk = RACKS.find(r => r.id === id);
            if(!rk) return;
            rk.name = document.getElementById('ctxRowName').value;
            rk.identifier = document.getElementById('ctxRowIden').value;
            rk.rotation = parseFloat(document.getElementById('ctxRot').value) || 0;
            rk.depthM = parseFloat(document.getElementById('ctxDepth').value) || 1;
            rk.widthM = parseFloat(document.getElementById('ctxSize').value) || 2;
        } else {
            const z = ZONES.find(x => x.id === id);
            if(!z) return;
            z.name = document.getElementById('ctxZoneName').value;
            z.rotation = parseFloat(document.getElementById('ctxRot').value) || 0;
            z.widthM = parseFloat(document.getElementById('ctxZoneW').value) || 2;
            z.lengthM = parseFloat(document.getElementById('ctxZoneL').value) || 10;
        }
        
        const fbk = document.getElementById('mapSaveFeedback');
        fbk.style.display = 'block';
        setTimeout(() => fbk.style.display = 'none', 2000);
        sync();
    }

    function deleteMapItem() {
        if(!selectedMapItem) return;
        const t = selectedMapItem.type;
        const id = selectedMapItem.id;
        
        if(t === 'row') {
            if(PRODUCTS.some(p => p && p.rowId === id)) return alert("Saca primero los productos.");
            if(confirm("¿Eliminar fila completamente del sistema?")) { ROWS = ROWS.filter(r => r.id !== id); clearMapSelection(); sync(); }
        } else if (t === 'rack') {
            if(PRODUCTS.some(p => p.rowId && p.rowId.startsWith('RK-' + id + '-'))) return alert("Rack con productos. Mueve los productos antes.");
            if(confirm("¿Eliminar rack completamente?")) { RACKS = RACKS.filter(r => r.id !== id); clearMapSelection(); sync(); }
        } else {
            if(confirm("¿Eliminar pasillo/zona?")) { ZONES = ZONES.filter(z => z.id !== id); clearMapSelection(); sync(); }
        }
    }

    function unassignMapItem() {
        if(!selectedMapItem) return;
        if(selectedMapItem.type === 'row') {
            const row = ROWS.find(r => r.id === selectedMapItem.id);
            if(row) { row.whId = ""; row.x = 0; row.y = 0; row.rotation = 0; sync(); clearMapSelection(); }
        } else if (selectedMapItem.type === 'rack') {
            const rk = RACKS.find(r => r.id === selectedMapItem.id);
            if(rk) { rk.whId = ""; rk.x = 0; rk.y = 0; rk.rotation = 0; sync(); clearMapSelection(); }
        } else { alert("Los pasillos no se pueden desasignar."); }
    }

    function resetAllRowsToTray() {
        if(!activeWarehouseId) return;
        if(!confirm("¿Seguro que deseas devolver TODAS las estructuras de este plano a la bandeja de 'Por Asignar'? No perderás los productos.")) return;

        let recovered = 0;
        ROWS.forEach(r => { if(r.whId === activeWarehouseId) { r.whId = ""; r.x = 0; r.y = 0; r.rotation = 0; recovered++; } });
        RACKS.forEach(r => { if(r.whId === activeWarehouseId) { r.whId = ""; r.x = 0; r.y = 0; r.rotation = 0; recovered++; } });
        
        if(recovered > 0) { 
            sync(); 
            alert(`Se devolvieron ${recovered} estructuras a la bandeja.`); 
        } else { 
            alert("No hay estructuras en el plano para mover."); 
        }
    }

    function toggleLayoutMode() {
        const canvas = document.getElementById('mapCanvas');
        if(document.getElementById('modeMoveRows').checked) canvas.classList.add('layout-mode'); 
        else canvas.classList.remove('layout-mode'); 
    }

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
        WAREHOUSES.forEach(w => selHtml += `<option value="${w.id}" ${w.id === activeWarehouseId ? 'selected' : ''}>${w.name}</option>`);
        if(sel) sel.innerHTML = selHtml;

        const activeWH = WAREHOUSES.find(w => w.id === activeWarehouseId) || WAREHOUSES[0];
        if (!activeWH) return;

        const scale = activeWH.scale || 25;
        const canvas = document.getElementById('mapCanvas');
        if(!canvas) return;
        
        canvas.style.width = (activeWH.widthM * scale) + 'px';
        canvas.style.height = (activeWH.lengthM * scale) + 'px';
        canvas.innerHTML = '<div id="mapRotTooltip" class="rotation-tooltip"></div>'; 

        const whZones = ZONES.filter(z => z.whId === activeWH.id);
        whZones.forEach(zone => {
            const zEl = document.createElement('div');
            zEl.className = 'map-entity-zone';
            if(selectedMapItem && selectedMapItem.id === zone.id) zEl.className += ' is-selected';
            
            zEl.id = 'map-zone-' + zone.id;
            zEl.style.width = (zone.widthM * scale) + 'px';
            zEl.style.height = (zone.lengthM * scale) + 'px';
            zEl.style.left = (zone.x * scale) + 'px';
            zEl.style.top = (zone.y * scale) + 'px';
            zEl.style.transform = `rotate(${zone.rotation || 0}deg)`;
            zEl.innerHTML = `<span>${zone.name||''}</span>`;
            
            const rotHandle = document.createElement('div');
            rotHandle.className = 'rotator-handle';
            rotHandle.innerHTML = '<div class="rotator-line"></div>';
            rotHandle.onmousedown = e => initRotate(e, 'zone', zone.id);
            zEl.appendChild(rotHandle);

            zEl.onmousedown = e => { selectMapItem('zone', zone.id); initMapDrag(e, 'zone', zone.id); };
            canvas.appendChild(zEl);
        });

        const assignedRows = [];
        const unassignedRows = [];
        ROWS.forEach(r => { if (r.whId === activeWH.id) assignedRows.push(r); else if (!r.whId) unassignedRows.push(r); });
        RACKS.forEach(r => { if (r.whId === activeWH.id) assignedRows.push(Object.assign({isRack: true}, r)); else if (!r.whId) unassignedRows.push(Object.assign({isRack: true}, r)); });

        assignedRows.forEach(row => {
            if (row.isRack) {
                const rEl = document.createElement('div');
                rEl.className = 'map-entity-rack';
                if(selectedMapItem && selectedMapItem.id === row.id) rEl.className += ' is-selected';
                rEl.id = 'map-rack-' + row.id;
                
                rEl.style.width = (row.widthM * scale) + 'px';
                rEl.style.height = (row.depthM * scale) + 'px';
                rEl.style.left = ((row.x||0) * scale) + 'px';
                rEl.style.top = ((row.y||0) * scale) + 'px';
                rEl.style.transform = `rotate(${row.rotation || 0}deg)`;
                
                const rotHandle = document.createElement('div');
                rotHandle.className = 'rotator-handle';
                rotHandle.innerHTML = '<div class="rotator-line"></div>';
                rotHandle.onmousedown = e => initRotate(e, 'rack', row.id);
                rEl.appendChild(rotHandle);

                const lbl = document.createElement('div');
                lbl.className = 'map-entity-row-label rack-label';
                lbl.innerHTML = '🖐️ [RACK] ' + (row.name || 'Sin Nombre') + (row.identifier ? ` (${row.identifier})` : '');
                lbl.onmousedown = e => { selectMapItem('rack', row.id); initMapDrag(e, 'rack', row.id); };
                rEl.appendChild(lbl);
                
                rEl.ondblclick = e => { e.stopPropagation(); openRackFrontModal(row.id); };
                canvas.appendChild(rEl);

            } else {
                const rEl = document.createElement('div');
                let shapeClass = '';
                if(row.shape === 'L') shapeClass = ' shape-L';
                else if(row.shape === 'U' || row.shape === 'C') shapeClass = ' shape-U';
                
                rEl.className = 'map-entity-row' + shapeClass;
                if(selectedMapItem && selectedMapItem.id === row.id) rEl.className += ' is-selected';
                rEl.id = 'map-row-' + row.id;
                
                const depthM = row.depthM || 1.2;
                const dPx = depthM * scale;
                let totalW = row.sizeM || 15;
                let totalH = dPx;
                const boxVisualW = 0.6; 
                let cap1 = row.cap1 || 5, cap2 = row.cap2 || 10, cap3 = row.cap3 || 5;

                let seg1El = null, seg2El = null, seg3El = null;

                if(row.shape === 'L') {
                    const s1 = cap1 * boxVisualW; const s2 = cap2 * boxVisualW;
                    totalW = (s2 + depthM) * scale; totalH = (s1 + depthM) * scale;
                    rEl.style.flexDirection = 'column';
                    
                    seg1El = document.createElement('div'); seg1El.className = 'map-segment map-segment-v';
                    seg1El.style.width = dPx + 'px'; seg1El.style.height = (s1 * scale) + 'px';
                    seg2El = document.createElement('div'); seg2El.className = 'map-segment map-segment-h';
                    seg2El.style.height = dPx + 'px'; seg2El.style.width = (s2 * scale) + 'px';
                    seg2El.style.position = 'absolute'; seg2El.style.bottom = '0'; seg2El.style.left = dPx + 'px';
                    rEl.appendChild(seg1El); rEl.appendChild(seg2El);
                } else if (row.shape === 'U' || row.shape === 'C') {
                    const s1 = cap1 * boxVisualW; const s2 = cap2 * boxVisualW; const s3 = cap3 * boxVisualW;
                    totalW = (s2 + (depthM*2)) * scale; totalH = (Math.max(s1, s3) + depthM) * scale;
                    
                    seg1El = document.createElement('div'); seg1El.className = 'map-segment map-segment-v';
                    seg1El.style.width = dPx + 'px'; seg1El.style.height = (s1 * scale) + 'px';
                    seg1El.style.position = 'absolute'; seg1El.style.bottom = '0'; seg1El.style.left = '0';
                    
                    seg2El = document.createElement('div'); seg2El.className = 'map-segment map-segment-h';
                    seg2El.style.height = dPx + 'px'; seg2El.style.width = (s2 * scale) + 'px';
                    seg2El.style.position = 'absolute'; seg2El.style.bottom = '0'; seg2El.style.left = dPx + 'px';
                    
                    seg3El = document.createElement('div'); seg3El.className = 'map-segment map-segment-v';
                    seg3El.style.width = dPx + 'px'; seg3El.style.height = (s3 * scale) + 'px';
                    seg3El.style.position = 'absolute'; seg3El.style.bottom = '0'; seg3El.style.right = '0';
                    
                    rEl.appendChild(seg1El); rEl.appendChild(seg2El); rEl.appendChild(seg3El);
                } else {
                    totalW = totalW * scale;
                }

                rEl.style.width = totalW + 'px'; rEl.style.height = totalH + 'px';
                rEl.style.left = ((row.x||0) * scale) + 'px'; rEl.style.top = ((row.y||0) * scale) + 'px';
                rEl.style.transform = `rotate(${row.rotation || 0}deg)`;

                const lbl = document.createElement('div');
                lbl.className = 'map-entity-row-label';
                lbl.innerHTML = '🖐️ ' + (row.name || 'Fila');
                lbl.onmousedown = e => { selectMapItem('row', row.id); initMapDrag(e, 'row', row.id); };
                rEl.appendChild(lbl);

                const rowProds = PRODUCTS.filter(p => p && p.rowId === row.id);
                let pCount = 0;

                rowProds.forEach(p => {
                    pCount++;
                    const pEl = generateProductHTML(p, 0, pCount, '', scale, false);
                    let targetSeg = rEl; 
                    if (row.shape === 'L') {
                        if (pCount <= cap1) { targetSeg = seg1El; pEl.style.height = 'auto'; pEl.style.flex = '1'; pEl.style.width = '100%'; }
                        else { targetSeg = seg2El; pEl.style.width = 'auto'; pEl.style.flex = '1'; pEl.style.height = '100%'; }
                    } else if (row.shape === 'U' || row.shape === 'C') {
                        if (pCount <= cap1) { targetSeg = seg1El; pEl.style.height = 'auto'; pEl.style.flex = '1'; pEl.style.width = '100%'; }
                        else if (pCount <= cap1 + cap2) { targetSeg = seg2El; pEl.style.width = 'auto'; pEl.style.flex = '1'; pEl.style.height = '100%'; }
                        else { targetSeg = seg3El; pEl.style.height = 'auto'; pEl.style.flex = '1'; pEl.style.width = '100%'; }
                    } else {
                        pEl.style.height = '100%';
                    }
                    pEl.onmousedown = e => e.stopPropagation(); 
                    targetSeg.appendChild(pEl);
                });

                canvas.appendChild(rEl);
            }
        });

        const unassignWrap = document.getElementById('mapUnassignedRows');
        let uHtml = '';
        if (unassignedRows.length === 0) {
            uHtml = '<p style="color:var(--ok); font-size:0.8rem; text-align:center;">Todas las estructuras están ubicadas.</p>';
        } else {
            unassignedRows.forEach(ur => {
                const prefix = ur.isRack ? '<b style="color:var(--order-blue)">[RACK] ' : '<b>';
                const idType = ur.isRack ? `rack','${ur.id}` : `row','${ur.id}`;
                uHtml += `<div class="unassigned-row-card">${prefix}${ur.name||''}</b><button class="btn btn-secondary" style="padding:4px 8px; font-size:0.7rem;" onclick="assignRowToMap('${ur.isRack ? 'rack' : 'row'}', '${ur.id}')">Al Plano ➡️</button></div>`;
            });
        }
        if(unassignWrap) unassignWrap.innerHTML = uHtml;
    }

    function initRotate(e, type, id) {
        e.stopPropagation(); e.preventDefault();
        selectMapItem(type, id); 
        
        const el = document.getElementById('map-' + type + '-' + id);
        const tooltip = document.getElementById('mapRotTooltip');
        if(!el || !tooltip) return;
        
        const rect = el.getBoundingClientRect();
        const centerX = rect.left + (rect.width / 2);
        const centerY = rect.top + (rect.height / 2);
        
        tooltip.style.display = 'block';

        function onRotateDrag(ev) {
            const dx = ev.clientX - centerX;
            const dy = ev.clientY - centerY;
            let angle = Math.atan2(dy, dx) * (180 / Math.PI);
            angle += 90; 
            angle = Math.round(angle);
            if (angle < 0) angle += 360;

            el.style.transform = `rotate(${angle}deg)`;
            
            const canvasRect = document.getElementById('mapCanvas').getBoundingClientRect();
            tooltip.style.left = (ev.clientX - canvasRect.left) + 'px';
            tooltip.style.top = (ev.clientY - canvasRect.top - 40) + 'px';
            tooltip.innerText = angle + '°';
            
            const ctxRot = document.getElementById('ctxRot');
            if(ctxRot) ctxRot.value = angle;

            if(type === 'row') { const r = ROWS.find(x => x.id === id); if(r) r.rotation = angle; } 
            else if(type === 'rack') { const r = RACKS.find(x => x.id === id); if(r) r.rotation = angle; } 
            else { const z = ZONES.find(x => x.id === id); if(z) z.rotation = angle; }
        }

        function onRotateDrop() {
            document.removeEventListener('mousemove', onRotateDrag);
            document.removeEventListener('mouseup', onRotateDrop);
            tooltip.style.display = 'none';
            sync(); 
        }

        document.addEventListener('mousemove', onRotateDrag);
        document.addEventListener('mouseup', onRotateDrop);
    }

    function assignRowToMap(type, id) {
        if(!activeWarehouseId) return;
        if (type === 'row') {
            const row = ROWS.find(r => r.id === id);
            if(row) { row.whId = activeWarehouseId; row.x = 0; row.y = 0; row.rotation = 0; sync(); }
        } else if (type === 'rack') {
            const rack = RACKS.find(r => r.id === id);
            if(rack) { rack.whId = activeWarehouseId; rack.x = 0; rack.y = 0; rack.rotation = 0; sync(); }
        }
    }

    function initMapDrag(e, type, id) {
        if (e.button !== 0) return; 
        e.stopPropagation();
        
        const el = document.getElementById('map-' + type + '-' + id);
        if(!el) return; 
        
        draggingMapItem = { type: type, id: id };
        
        const canvas = document.getElementById('mapCanvas');
        const canvasRect = canvas.getBoundingClientRect();
        
        const currentLeft = parseFloat(el.style.left) || 0;
        const currentTop = parseFloat(el.style.top) || 0;
        
        dragOffsetX = (e.clientX - canvasRect.left) - currentLeft;
        dragOffsetY = (e.clientY - canvasRect.top) - currentTop;

        document.addEventListener('mousemove', onMapDrag);
        document.addEventListener('mouseup', onMapDrop);
    }

    function onMapDrag(e) {
        if(!draggingMapItem) return;
        const canvas = document.getElementById('mapCanvas');
        if(!canvas) return;
        const canvasRect = canvas.getBoundingClientRect();
        
        let x = (e.clientX - canvasRect.left) - dragOffsetX;
        let y = (e.clientY - canvasRect.top) - dragOffsetY;

        const el = document.getElementById('map-' + draggingMapItem.type + '-' + draggingMapItem.id);
        if(el) { el.style.left = x + 'px'; el.style.top = y + 'px'; }
    }

    function onMapDrop(e) {
        document.removeEventListener('mousemove', onMapDrag);
        document.removeEventListener('mouseup', onMapDrop);
        if(!draggingMapItem) return;

        const canvas = document.getElementById('mapCanvas');
        const activeWH = WAREHOUSES.find(w => w.id === activeWarehouseId);
        const scale = activeWH ? (activeWH.scale || 25) : 25;

        const canvasRect = canvas.getBoundingClientRect();
        let x = (e.clientX - canvasRect.left) - dragOffsetX;
        let y = (e.clientY - canvasRect.top) - dragOffsetY;

        let xM = parseFloat((x / scale).toFixed(2));
        let yM = parseFloat((y / scale).toFixed(2));

        if(draggingMapItem.type === 'row') {
            const row = ROWS.find(r => r.id === draggingMapItem.id);
            if(row) { row.x = xM; row.y = yM; }
        } else if (draggingMapItem.type === 'rack') {
            const rack = RACKS.find(r => r.id === draggingMapItem.id);
            if(rack) { rack.x = xM; rack.y = yM; }
        } else if (draggingMapItem.type === 'zone') {
            const zone = ZONES.find(z => z.id === draggingMapItem.id);
            if(zone) { zone.x = xM; zone.y = yM; }
        }

        draggingMapItem = null;
        sync(); 
    }

    function openWarehouseModal(id) {
        const wh = (id && typeof id === 'string') ? WAREHOUSES.find(x => x.id === id) : null;
        if(wh) {
            document.getElementById('whId').value = wh.id; document.getElementById('whName').value = wh.name;
            document.getElementById('whWidth').value = wh.widthM; document.getElementById('whLength').value = wh.lengthM;
            document.getElementById('whScale').value = wh.scale || 25; document.getElementById('btnDelWh').style.display = 'block';
            document.getElementById('whModalTitle').innerText = "Editar Bodega";
        } else {
            document.getElementById('whId').value = ''; document.getElementById('whName').value = '';
            document.getElementById('whWidth').value = ''; document.getElementById('whLength').value = '';
            document.getElementById('whScale').value = 25; document.getElementById('btnDelWh').style.display = 'none';
            document.getElementById('whModalTitle').innerText = "Nueva Bodega";
        }
        document.getElementById('warehouseModal').classList.add('open');
    }

    function saveWarehouse() {
        const id = document.getElementById('whId').value || 'WH' + Date.now();
        const name = document.getElementById('whName').value.trim();
        if(!name) return alert("El nombre es requerido.");
        
        const widthM = parseFloat(document.getElementById('whWidth').value) || 30;
        const lengthM = parseFloat(document.getElementById('whLength').value) || 20;

        const data = { id: id, name: name, widthM: widthM, lengthM: lengthM, scale: parseFloat(document.getElementById('whScale').value) || 25 };
        const idx = WAREHOUSES.findIndex(x => x.id === id);
        if(idx >= 0) WAREHOUSES[idx] = data; else WAREHOUSES.push(data);
        
        ROWS.forEach(function(r) {
            if (r.whId === id) { if (r.x > widthM || r.y > lengthM) { r.x = 0; r.y = 0; } }
        });

        activeWarehouseId = id; sync(); closeModals();
    }

    function deleteWarehouse() {
        const id = document.getElementById('whId').value;
        if(confirm("¿Eliminar Bodega? Se perderán los pasillos trazados. Sus filas volverán a 'Por Asignar' intactas.")) {
            ROWS.forEach(r => { if(r.whId === id) { r.whId = ""; r.x = 0; r.y = 0; r.rotation = 0; } });
            RACKS.forEach(r => { if(r.whId === id) { r.whId = ""; r.x = 0; r.y = 0; r.rotation = 0; } });
            WAREHOUSES = WAREHOUSES.filter(w => w.id !== id);
            ZONES = ZONES.filter(z => z.whId !== id);
            activeWarehouseId = WAREHOUSES.length ? WAREHOUSES[0].id : null;
            clearMapSelection();
            sync(); 
            closeModals();
        }
    }

    function openZoneModal(id) {
        if(!activeWarehouseId) return alert("Selecciona o crea una bodega primero.");
        const z = (id && typeof id === 'string') ? ZONES.find(x => x.id === id) : null;
        if(z) {
            document.getElementById('zId').value = z.id; document.getElementById('zName').value = z.name;
            document.getElementById('zWidth').value = z.widthM; document.getElementById('zLength').value = z.lengthM;
            document.getElementById('btnDelZone').style.display = 'block';
        } else {
            document.getElementById('zId').value = ''; document.getElementById('zName').value = '';
            document.getElementById('zWidth').value = 4; document.getElementById('zLength').value = 10;
            document.getElementById('btnDelZone').style.display = 'none';
        }
        document.getElementById('zoneModal').classList.add('open');
    }

    function saveZone() {
        const id = document.getElementById('zId').value || 'Z' + Date.now();
        const data = { id: id, whId: activeWarehouseId, name: document.getElementById('zName').value || 'Pasillo', widthM: parseFloat(document.getElementById('zWidth').value) || 2, lengthM: parseFloat(document.getElementById('zLength').value) || 10, x: 0, y: 0, rotation: 0 };
        const exist = ZONES.find(x => x.id === id);
        if(exist) { data.x = exist.x; data.y = exist.y; data.rotation = exist.rotation; }
        const idx = ZONES.findIndex(x => x.id === id);
        if(idx >= 0) ZONES[idx] = data; else ZONES.push(data);
        sync(); closeModals();
    }

    function deleteZone() {
        const id = document.getElementById('zId').value;
        if(confirm("¿Eliminar pasillo/zona?")) { ZONES = ZONES.filter(z => z.id !== id); sync(); closeModals(); }
    }

    // MÓDULO GOOGLE SHEETS SYNC
    function openIntegrationsModal() {
        document.getElementById('gsheetIdInput').value = gsheetsConfig.sheetId || '';
        document.getElementById('gsheetTabInput').value = gsheetsConfig.tabName || 'Productos';
        document.getElementById('lastSyncLabel').innerText = gsheetsConfig.lastSync ? 'Última Sincronización: ' + gsheetsConfig.lastSync : 'Última Sincronización: Nunca';
        document.getElementById('integrationsModal').classList.add('open');
    }

    function saveIntegrationsConfig() {
        gsheetsConfig.sheetId = document.getElementById('gsheetIdInput').value.trim();
        gsheetsConfig.tabName = document.getElementById('gsheetTabInput').value.trim() || 'Productos';
        
        if (!gsheetsConfig.sheetId) return alert("Debe ingresar un ID de hoja válido o una URL de Publicación.");
        
        sync();
        alert("Configuración de Google Sheets guardada en Firebase.");
    }

    function normalizeHeader(str) {
        if (!str) return '';
        return str.toString()
            .toLowerCase()
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "") 
            .replace(/[^a-z0-9]/g, "") 
            .trim();
    }

    function startGoogleSheetsSync() {
        const inputVal = document.getElementById('gsheetIdInput').value.trim();
        const tabName = document.getElementById('gsheetTabInput').value.trim() || 'Productos';
        
        console.clear();
        console.log("=== [DEPURACIÓN GS] PASO 1: Captura de Entrada ===");
        console.log("Entrada del Operador:", inputVal);

        if (!inputVal) {
            console.error("[DEPURACIÓN GS] ERROR: URL o ID vacío.");
            return alert("Ingrese la URL de publicación CSV o el ID de la hoja de Google Sheets.");
        }

        const btn = document.getElementById('btnSyncGs');
        btn.innerText = "⏳ Descargando y Analizando...";
        btn.disabled = true;

        let url = '';
        if (inputVal.startsWith('http') && inputVal.includes('pub')) {
            url = inputVal;
        } else if (inputVal.startsWith('http')) {
            const match = inputVal.match(/\/d\/([a-zA-Z0-9-_]+)/);
            if (match && match[1]) {
                url = `https://docs.google.com/spreadsheets/d/${match[1]}/export?format=csv&sheet=${encodeURIComponent(tabName)}`;
            } else {
                url = inputVal;
            }
        } else {
            url = `https://docs.google.com/spreadsheets/d/${inputVal}/export?format=csv&sheet=${encodeURIComponent(tabName)}`;
        }

        console.log("=== [DEPURACIÓN GS] PASO 2: URL de Conexión Generada ===");
        console.log("Target API URL:", url);

        console.log("=== [DEPURACIÓN GS] PASO 3: Ejecutando fetch()...");
        fetch(url)
            .then(res => {
                console.log("=== [DEPURACIÓN GS] PASO 4: Respuesta HTTP Recibida ===");
                console.log("Código HTTP:", res.status, res.statusText);
                console.log("Headers (Content-Type):", res.headers.get('content-type'));
                
                if(!res.ok) throw new Error(`HTTP_STATUS_${res.status}: ${res.statusText}`);
                return res.text();
            })
            .then(csv => {
                console.log("=== [DEPURACIÓN GS] PASO 5: Contenido Crudo Recibido ===");
                console.log("Muestra (Primeros 300 caracteres):\n", csv.substring(0, 300));

                if (csv.trim().startsWith("<!DOCTYPE") || csv.trim().toLowerCase().startsWith("<html")) {
                    console.error("[DEPURACIÓN GS] ERROR: Respuesta devuelta es HTML (Google pide autenticación).");
                    throw new Error("Google bloqueó la solicitud o solicitó inicio de sesión por redirección web. Asegúrese de usar 'Publicar en la web' > Formato 'CSV'!");
                }
                
                btn.innerText = "🔄 Sincronizar Ahora";
                btn.disabled = false;
                processGSheetsCSV(csv);
            })
            .catch(err => {
                btn.innerText = "🔄 Sincronizar Ahora";
                btn.disabled = false;
                console.error("=== [DEPURACIÓN GS] FALLA CRÍTICA DE CONEXIÓN ===", err);
                
                let errMsg = err.message;
                if (errMsg === 'Failed to fetch') {
                    errMsg = "El navegador bloqueó la solicitud (Error de CORS).\n\nCausa real: Su cuenta Google Workspace tiene restricciones que impiden descargar la hoja mediante fetch.\n\nSOLUCIÓN:\nEn su Sheets vaya a 'Archivo' > 'Compartir' > 'Publicar en la web' > Elija pestaña 'Productos' > Formato 'CSV' y pegue ese enlace público de publicación aquí.";
                }
                alert(`Error detectado:\n\n${errMsg}`);
            });
    }

    function processGSheetsCSV(csvText) {
        console.log("=== [DEPURACIÓN GS] PASO 6: Iniciando Parseo de Filas ===");
        const rows = [];
        let curRow = [];
        let curCell = '';
        let inQuotes = false;
        
        for (let i = 0; i < csvText.length; i++) {
            let c = csvText[i];
            if (inQuotes) {
                if (c === '"') {
                    if (i + 1 < csvText.length && csvText[i + 1] === '"') { curCell += '"'; i++; }
                    else { inQuotes = false; }
                } else { curCell += c; }
            } else {
                if (c === '"') { inQuotes = true; }
                else if (c === ',' || c === ';') { curRow.push(curCell.trim()); curCell = ''; }
                else if (c === '\n' || c === '\r') {
                    curRow.push(curCell.trim()); 
                    rows.push(curRow);
                    curRow = []; curCell = '';
                    if (c === '\r' && csvText[i + 1] === '\n') i++;
                } else { curCell += c; }
            }
        }
        if (curCell || curRow.length > 0) { curRow.push(curCell.trim()); rows.push(curRow); }

        const validRows = rows.filter(r => r.length > 0 && r.some(cell => cell !== ''));
        console.log("Total filas parseadas:", rows.length);
        console.log("Filas válidas con contenido:", validRows.length);

        if (validRows.length < 2) {
            console.error("[DEPURACIÓN GS] ERROR: La hoja no tiene suficientes filas para sincronizar.");
            return alert("La hoja parece estar vacía o no tiene el formato correcto.");
        }

        console.log("=== [DEPURACIÓN GS] PASO 7: Mapeo de Encabezados (Unicode NFD Normalizado) ===");
        const rawHeaders = validRows[0];
        const headers = rawHeaders.map(h => normalizeHeader(h));
        console.log("Encabezados Originales:", rawHeaders);
        console.log("Encabezados Normalizados:", headers);

        const idxSku = headers.findIndex(h => h === 'sku' || h === 'codigo' || h === 'codigosap');
        const idxName = headers.findIndex(h => h === 'nombre' || h === 'descripcion' || h === 'vinos' || h === 'vino');
        const idxQty = headers.findIndex(h => h === 'cantidad' || h === 'stock' || h === 'fisico' || h === 'real' || h === 'current');
        const idxLoc = headers.findIndex(h => h === 'ubicacion' || h === 'posicion' || h === 'coordenada');
        const idxMin = headers.findIndex(h => h === 'minimo' || h === 'min');
        const idxMax = headers.findIndex(h => h === 'maximo' || h === 'max');
        const idxProv = headers.findIndex(h => h === 'proveedor' || h === 'supplier');
        const idxLead = headers.findIndex(h => h === 'demora' || h === 'leadtime' || h === 'reposicion');
        const idxW = headers.findIndex(h => h === 'ancho' || h === 'width');
        const idxH = headers.findIndex(h => h === 'alto' || h === 'height');
        const idxD = headers.findIndex(h => h === 'profundidad' || h === 'profundo' || h === 'depth' || h === 'fondo');

        console.log("Índices detectados:", { idxSku, idxName, idxQty, idxLoc, idxMin, idxMax, idxProv, idxLead });

        if (idxSku === -1) {
            console.error("[DEPURACIÓN GS] ERROR: No se localizó la columna de SKU.");
            return alert("No se encontró la columna obligatoria 'SKU' o 'Código' en la hoja.");
        }

        window.pendingSyncDiff = { new: [], modified: [] };
        const dataRows = validRows.slice(1);
        let recordsProcessed = 0;
        let recordsValid = 0;
        let recordsDiscarded = 0;

        dataRows.forEach((cols, idx) => {
            recordsProcessed++;
            const skuRaw = cols[idxSku];
            if (!skuRaw || skuRaw.trim() === "") {
                recordsDiscarded++;
                console.warn(`[DEPURACIÓN GS] Fila ${idx + 2} descartada: SKU vacío.`);
                return;
            }

            recordsValid++;
            const sku = skuRaw.trim();
            const name = idxName !== -1 ? cols[idxName] : 'Producto Nuevo';
            
            const qtyStr = cols[idxQty] ? String(cols[idxQty]).replace(/\./g,'').replace(/,/g,'') : '';
            const qty = qtyStr !== '' ? (parseInt(qtyStr) || 0) : 0;
            
            const loc = idxLoc !== -1 ? cols[idxLoc] : '';
            const min = idxMin !== -1 ? (parseInt(cols[idxMin]) || 0) : 0;
            const max = idxMax !== -1 ? (parseInt(cols[idxMax]) || 0) : 0;
            const prov = idxProv !== -1 ? cols[idxProv] : '';
            const lead = idxLead !== -1 ? (parseInt(cols[idxLead]) || 0) : 0;
            
            const wStr = idxW !== -1 && cols[idxW] ? String(cols[idxW]).replace(',', '.') : '';
            const w = wStr !== '' ? (parseFloat(wStr) || 0.56) : 0.56;
            
            const hStr = idxH !== -1 && cols[idxH] ? String(cols[idxH]).replace(',', '.') : '';
            const h = hStr !== '' ? (parseFloat(hStr) || 0) : 0;
            
            const dStr = idxD !== -1 && cols[idxD] ? String(cols[idxD]).replace(',', '.') : '';
            const d = dStr !== '' ? (parseFloat(dStr) || 0) : 0;

            const existingIdx = PRODUCTS.findIndex(p => p.sku === sku);
            
            let mappedRowId = '';
            if (loc) {
                mappedRowId = findLocationId(loc);
            }

            if (existingIdx >= 0) {
                const p = PRODUCTS[existingIdx];
                let changed = false;
                let changes = [];
                
                if (p.current !== qty) { changed = true; changes.push(`Stock: ${p.current} -> ${qty}`); }
                if (p.name !== name) { changed = true; changes.push(`Nombre modificado`); }
                if (p.min !== min) { changed = true; changes.push(`Mínimo: ${p.min} -> ${min}`); }
                if (mappedRowId && p.rowId !== mappedRowId) { changed = true; changes.push(`Reubicado: ${mappedRowId}`); }

                if (changed) {
                    window.pendingSyncDiff.modified.push({
                        sku, name, qty, min, max, prov, lead, w, h, d, loc: mappedRowId,
                        oldQty: p.current, changes: changes.join(' | ')
                    });
                }
            } else {
                window.pendingSyncDiff.new.push({ sku, name, qty, min, max, prov, lead, w, h, d, loc: mappedRowId });
            }
        });

        console.log("=== [DEPURACIÓN GS] PASO 8: Resumen del Análisis ===");
        console.log("Procesados:", recordsProcessed);
        console.log("Válidos para WMS:", recordsValid);
        console.log("Descartados/Omitidos:", recordsDiscarded);
        console.log("Nuevos detectados:", window.pendingSyncDiff.new.length);
        console.log("Modificaciones detectadas:", window.pendingSyncDiff.modified.length);

        openSyncPreviewModal();
    }

    function openSyncPreviewModal() {
        document.getElementById('integrationsModal').classList.remove('open');
        document.getElementById('countSyncNew').innerText = window.pendingSyncDiff.new.length;
        document.getElementById('countSyncMod').innerText = window.pendingSyncDiff.modified.length;

        const tNew = document.getElementById('syncNewBody');
        tNew.innerHTML = '';
        if (window.pendingSyncDiff.new.length === 0) {
            tNew.innerHTML = '<tr><td colspan="4" style="text-align:center; padding:15px; color:var(--muted);">Sin nuevos productos.</td></tr>';
        } else {
            window.pendingSyncDiff.new.forEach(p => {
                tNew.innerHTML += `<tr>
                    <td><b style="color:var(--text);">${p.sku}</b></td>
                    <td>${p.name}</td>
                    <td style="color:var(--ok); font-weight:bold;">${p.qty}</td>
                    <td style="font-family:'DM Mono';">${p.loc || 'Bandeja'}</td>
                </tr>`;
            });
        }

        const tMod = document.getElementById('syncModBody');
        tMod.innerHTML = '';
        if (window.pendingSyncDiff.modified.length === 0) {
            tMod.innerHTML = '<tr><td colspan="3" style="text-align:center; padding:15px; color:var(--muted);">Sin modificaciones detectadas.</td></tr>';
        } else {
            window.pendingSyncDiff.modified.forEach(p => {
                tMod.innerHTML += `<tr>
                    <td><b style="color:var(--warn);">${p.sku}</b></td>
                    <td>${p.name}</td>
                    <td style="font-size:0.8rem;">${p.changes}</td>
                </tr>`;
            });
        }

        document.getElementById('syncPreviewModal').classList.add('open');
    }

    function applyGoogleSheetsSync() {
        if (!window.pendingSyncDiff) return;
        
        let pendingLogs = [];

        window.pendingSyncDiff.new.forEach(item => {
            PRODUCTS.push({
                sku: item.sku, name: item.name, rowId: item.loc, current: item.qty,
                min: item.min, max: item.max, supplier: item.prov, leadTime: item.lead,
                widthM: item.w, heightM: item.h, depthM: item.d,
                color: "#c8a84b", masterQty: 0, innerQty: 0, hasPO: false, reservedStock: 0, photo: null
            });
            pendingLogs.push({ sku: item.sku, name: item.name, change: item.qty, reason: "GSheets: Producto Creado" });
        });

        window.pendingSyncDiff.modified.forEach(item => {
            const idx = PRODUCTS.findIndex(p => p.sku === item.sku);
            if (idx >= 0) {
                let diffQty = item.qty - PRODUCTS[idx].current;
                PRODUCTS[idx].name = item.name;
                PRODUCTS[idx].current = item.qty;
                PRODUCTS[idx].min = item.min;
                PRODUCTS[idx].max = item.max;
                PRODUCTS[idx].supplier = item.prov;
                PRODUCTS[idx].leadTime = item.lead;
                PRODUCTS[idx].widthM = item.w;
                PRODUCTS[idx].heightM = item.h;
                PRODUCTS[idx].depthM = item.d;
                if (item.loc) PRODUCTS[idx].rowId = item.loc;
                
                pendingLogs.push({ sku: item.sku, name: item.name, change: diffQty, reason: "GSheets: Actualización de Parámetros" });
            }
        });

        const dateStr = new Date().toLocaleString('es-CL');
        gsheetsConfig.lastSync = dateStr;

        sync(); 
        pendingLogs.forEach(log => logMovement(log.sku, log.name, log.change, log.reason));
        
        document.getElementById('syncPreviewModal').classList.remove('open');
        alert("¡Sincronización aplicada exitosamente en el WMS y en Firebase!");
    }

    // EXPOSICIÓN GLOBAL
    window.handleLogin = handleLogin;
    window.drop = drop;
    window.handleSearch = handleSearch;
    window.selectSuggestion = selectSuggestion;
    window.openProductModal = openProductModal;
    window.saveProduct = saveProduct;
    window.openPoModal = openPoModal;
    window.openInventoryDB = openInventoryDB;
    window.applyDBChanges = applyDBChanges;
    window.openHistoryModal = openHistoryModal;
    window.toggleSapSection = toggleSapSection;
    window.processSapPaste = processSapPaste;
    window.openOrderModal = openOrderModal;
    window.processOrderPaste = processOrderPaste;
    window.toggleOrderItem = toggleOrderItem;
    window.updateOrderPickedQty = updateOrderPickedQty;
    window.cancelActiveOrder = cancelActiveOrder;
    window.finalizeOrder = finalizeOrder;
    window.deleteProduct = deleteProduct;
    window.openRowModal = openRowModal;
    window.saveRow = saveRow;
    window.deleteRow = deleteRow;
    window.openRackModal = openRackModal;
    window.renderRackColConfig = renderRackColConfig;
    window.updateRackLvlCount = updateRackLvlCount;
    window.saveRack = saveRack;
    window.deleteRack = deleteRack;
    window.openRackFrontModal = openRackFrontModal;
    window.processImage = processImage;
    window.closeModals = closeModals;
    window.closeProductModalOnly = closeProductModalOnly;
    window.clearMapSelection = clearMapSelection;
    window.unassignMapItem = unassignMapItem;
    window.saveMapItem = saveMapItem;
    window.deleteMapItem = deleteMapItem;
    window.toggleLayoutMode = toggleLayoutMode;
    window.toggleViewMode = toggleViewMode;
    window.changeActiveWarehouse = changeActiveWarehouse;
    window.resetAllRowsToTray = resetAllRowsToTray;
    window.openWarehouseModal = openWarehouseModal;
    window.saveWarehouse = saveWarehouse;
    window.deleteWarehouse = deleteWarehouse;
    window.openZoneModal = openZoneModal;
    window.saveZone = saveZone;
    window.deleteZone = deleteZone;
    
    // EXPOSICIÓN MÓDULO GOOGLE SHEETS
    window.openIntegrationsModal = openIntegrationsModal;
    window.saveIntegrationsConfig = saveIntegrationsConfig;
    window.startGoogleSheetsSync = startGoogleSheetsSync;
    window.applyGoogleSheetsSync = applyGoogleSheetsSync;
    window.findLocationId = findLocationId;
}
